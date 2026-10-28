// SnowLuma 连接管理：自动发现端点/令牌 → 建 WebSocket → 断线自愈 + 看门狗。
//
// 两个必须处理的坑（对照参考实现实测确认）：
//   1. **HTTP 与 WebSocket 是两个不同的 token、端口也不同**（默认 HTTP 3000 / WS 3001）。
//      换 QQ 账号后旧 token 直接 401，所以要能重新发现，并**同时**更新这两个值。
//   2. **只手触发 error、不触发 close 的握手失败**：Node 内置 WebSocket 在握手被拒
//      （例如拿 HTTP token 去连 WS 端口，non-101）时实测只触发 'error'，于是挂在
//      'close' 上的自愈永远不执行、进程一直停在「未连接」，且外部毫无异常。
//      所以自愈要同时挂在 error 与 close 上，并额外加一个看门狗兜底。
//
// 本模块只用 Node 内置 WebSocket 与 fetch，不引入额外运行时依赖。
import { Logger } from '../utils/log4js';
import { requireWebSocket } from '../utils';
import { ConnectionStatus, SnowLumaOptions, SnowLumaState } from '../dto/ConnectionDTO';
import { discoverSnowLumaConnection } from '../utils/snowLumaConn';

const DEFAULT_WS_URL = 'ws://127.0.0.1:3001';
const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';
/** 看门狗检查间隔。 */
const WATCHDOG_MS = 10_000;
/** 重连退避的起止间隔。 */
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;
/** 单次 OneBot action 的超时。 */
const ACTION_TIMEOUT_MS = 8_000;
/** WebSocket 的 OPEN 状态码。 */
const WS_OPEN = 1;

/** 令牌脱敏：接口与日志里都不出现完整令牌。 */
function maskToken(token: string): string {
    if (!token) return '';
    if (token.length <= 8) return '****';
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

interface PendingAction {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class SnowLumaManager {
    private readonly options: SnowLumaOptions;
    private wsUrl: string;
    private httpUrl: string;
    private token: string;
    private wsToken = '';
    private self: { userId: string; nickname: string } | null = null;
    private source: string | null = null;
    private status: ConnectionStatus = 'idle';
    private lastError: string | null = null;
    private lastEventAt: number | null = null;
    private heartbeatGood: boolean | null = null;
    private attempts = 0;
    private updatedAt = Date.now();

    private stopped = true;
    private connecting = false;
    private socket: any = null;
    private retryMs = MIN_RETRY_MS;
    private watchdogTimer: NodeJS.Timeout | null = null;
    private retryTimer: NodeJS.Timeout | null = null;
    private echoSeq = 0;
    private readonly pending = new Map<string, PendingAction>();

    constructor(options: SnowLumaOptions = {}) {
        this.options = options ?? {};
        this.wsUrl = process.env.SNOWLUMA_WS_URL || DEFAULT_WS_URL;
        this.httpUrl = String(this.options.httpUrl || process.env.SNOWLUMA_HTTP_URL || DEFAULT_HTTP_URL).replace(/\/+$/, '');
        this.token = this.options.accessToken || process.env.SNOWLUMA_TOKEN || '';
        this.wsToken = process.env.SNOWLUMA_WS_TOKEN || '';
    }

    /** 开始连接：先发现端点，再建 WebSocket，并启动看门狗。 */
    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        Logger.info('[SnowLuma] 开始连接');
        void this.connect();

        this.watchdogTimer = setInterval(() => void this.watchdog(), WATCHDOG_MS);
        this.watchdogTimer.unref?.();
    }

    /** 停止连接并清理所有定时器。 */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.watchdogTimer = null;
        this.retryTimer = null;

        this.closeSocket();
        this.rejectPending('连接已停止');
        this.status = 'idle';
        this.updatedAt = Date.now();
        Logger.info('[SnowLuma] 已停止');
    }

    /** 当前连接状态快照。 */
    getState(): SnowLumaState {
        return {
            status: this.status,
            wsUrl: this.wsUrl,
            httpUrl: this.httpUrl,
            token: maskToken(this.token),
            self: this.self,
            lastError: this.lastError,
            source: this.source,
            lastEventAt: this.lastEventAt,
            heartbeatGood: this.heartbeatGood,
            reconnectAttempts: this.attempts,
            updatedAt: this.updatedAt,
        };
    }

    private async connect(): Promise<void> {
        if (this.stopped || this.connecting || this.status === 'connected') return;
        this.connecting = true;
        try {
            this.status = 'connecting';
            // 每次重连都重新发现：令牌可能已随账号切换而轮换。
            await this.refreshEndpoint();
            this.openSocket();
        } catch (error) {
            this.lastError = (error as Error)?.message ?? String(error);
            Logger.error('[SnowLuma] 连接失败：', this.lastError);
            this.status = 'disconnected';
            this.scheduleRetry();
        } finally {
            this.connecting = false;
            this.updatedAt = Date.now();
        }
    }

    /**
     * 重新发现端点与令牌。
     *
     * 失败不抛错：此时仍按现有配置尝试连接，让「连不上」由连接本身暴露，
     * 而不是卡在发现阶段。
     */
    private async refreshEndpoint(): Promise<void> {
        try {
            const result = await discoverSnowLumaConnection({
                options: this.options,
                baseUrl: this.httpUrl,
                token: this.token || null,
            });

            if (!result.ok) {
                this.lastError = result.error ?? '未发现可用的 OneBot 令牌';
                return;
            }

            this.token = result.token ?? '';
            this.httpUrl = String(result.baseUrl ?? this.httpUrl).replace(/\/+$/, '');
            this.source = result.source ?? null;
            // 同一账号的 WS 令牌与地址：只修 HTTP 的话 WebSocket 仍然连不上。
            if (result.wsToken) this.wsToken = result.wsToken;
            if (result.wsUrl) this.wsUrl = result.wsUrl;
            if (result.self) {
                this.self = {
                    userId: String(result.self.user_id ?? ''),
                    nickname: String(result.self.nickname ?? ''),
                };
            }
            Logger.info(`[SnowLuma] 已发现端点（来源 ${this.source}）：${this.httpUrl} → ${this.wsUrl}`);
        } catch (error) {
            this.lastError = (error as Error)?.message ?? String(error);
        }
    }

    private openSocket(): void {
        const Impl = requireWebSocket();
        const headers: Record<string, string> = {};
        if (this.wsToken) headers.authorization = `Bearer ${this.wsToken}`;

        Logger.info(`[SnowLuma] 正在连接 WebSocket：${this.wsUrl}`);
        const socket = new Impl(this.wsUrl, { headers });
        this.socket = socket;

        socket.addEventListener('open', () => this.handleOpen());
        socket.addEventListener('message', (event: any) => this.handleMessage(event));
        socket.addEventListener('close', (event: any) => this.handleClose(`WebSocket 已关闭（code ${event?.code ?? '-'}）`));
        // 握手被拒时通常只到这里：自愈必须也挂在 error 上。
        socket.addEventListener('error', () => this.handleClose('WebSocket 握手或传输失败'));
    }

    private handleOpen(): void {
        this.attempts = 0;
        this.retryMs = MIN_RETRY_MS;
        this.lastError = null;
        this.status = 'connected';
        this.updatedAt = Date.now();
        Logger.info(`[SnowLuma] 已连接：${this.wsUrl}${this.self ? `（${this.self.nickname} ${this.self.userId}）` : ''}`);
        void this.loadLoginInfo();
    }

    /** 连上后补一次账号信息（HTTP 发现已拿到时只是刷新）。 */
    private async loadLoginInfo(): Promise<void> {
        try {
            const data = await this.sendAction('get_login_info');
            if (data) {
                this.self = {
                    userId: String(data.user_id ?? ''),
                    nickname: String(data.nickname ?? ''),
                };
            }
        } catch (error) {
            Logger.warn('[SnowLuma] 获取登录信息失败：', (error as Error)?.message ?? error);
        }
    }

    private handleMessage(event: any): void {
        let message: any;
        try {
            const raw = typeof event?.data === 'string' ? event.data : String(event?.data ?? '');
            message = JSON.parse(raw);
        } catch {
            Logger.warn('[SnowLuma] 收到无法解析的报文，已丢弃');
            return;
        }

        // 带 echo 的是我们主动调用的响应，没有 echo 的才是上游推送的事件。
        if (message?.echo) {
            const entry = this.pending.get(message.echo);
            if (!entry) return;
            this.pending.delete(message.echo);
            clearTimeout(entry.timer);
            if (message.status === 'ok' && message.retcode === 0) entry.resolve(message.data);
            else entry.reject(new Error(`${message.status}/${message.retcode} ${message.wording ?? ''}`.trim()));
            return;
        }

        this.lastEventAt = Date.now();
        this.updatedAt = this.lastEventAt;

        // 心跳里的 status.good 是「接收链路是否健康」的权威信号：SnowLuma 用原生 Hook
        // 挂进 QQ 进程收消息，这一层会退化 —— 进程与 WebSocket 都还活着，但一条消息都收不到。
        if (message?.post_type === 'meta_event' && message?.meta_event_type === 'heartbeat') {
            const good = message?.status?.good;
            if (typeof good === 'boolean') {
                if (this.heartbeatGood !== good) Logger.warn(`[SnowLuma] 上游接收链路 healthy=${good}`);
                this.heartbeatGood = good;
            }
        }
    }

    private handleClose(reason: string): void {
        // error 之后通常紧跟 close：第一次处理时已经把 socket 置空，第二次直接忽略。
        if (!this.socket) return;
        const wasConnected = this.status === 'connected';
        this.closeSocket();

        this.lastError = reason;
        this.status = 'disconnected';
        this.updatedAt = Date.now();
        this.rejectPending(reason);
        Logger.warn(`[SnowLuma] ${reason}${wasConnected ? '（原连接已断开）' : ''}`);
        this.scheduleRetry();
    }

    /** 通过 WebSocket 调一次 OneBot action，用 echo 关联响应。 */
    private sendAction(action: string, params: Record<string, any> = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const socket = this.socket;
            if (!socket || socket.readyState !== WS_OPEN) {
                reject(new Error(`WebSocket 未连接，无法调用 ${action}`));
                return;
            }

            const echo = `bridge-${++this.echoSeq}`;
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error(`${action} 超时（${ACTION_TIMEOUT_MS}ms）`));
            }, ACTION_TIMEOUT_MS);
            timer.unref?.();

            this.pending.set(echo, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify({ action, params, echo }));
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(echo);
                reject(error as Error);
            }
        });
    }

    /** 看门狗兜底：原生 WebSocket 握手被拒时可能既不重连、也不触发 close。 */
    private async watchdog(): Promise<void> {
        if (this.stopped || this.status === 'connected' || this.connecting) return;
        this.attempts += 1;
        Logger.warn(`[SnowLuma] 仍未连接，看门狗第 ${this.attempts} 次重连`);
        await this.connect();
    }

    private scheduleRetry(): void {
        if (this.stopped || this.retryTimer) return;
        const delay = this.retryMs;
        this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
        Logger.info(`[SnowLuma] ${Math.round(delay / 1000)} 秒后重连`);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.connect();
        }, delay);
        this.retryTimer.unref?.();
    }

    private closeSocket(): void {
        const socket = this.socket;
        this.socket = null;
        if (!socket) return;
        try {
            socket.close();
        } catch {
            // 已经断了。
        }
    }

    private rejectPending(reason: string): void {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error(reason));
        }
        this.pending.clear();
    }
}
