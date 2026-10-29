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
import { QqMessage } from '../dto/BridgeDTO';
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
/** 发送消息的超时（发消息走 HTTP API，不是 WS action）。 */
const SEND_TIMEOUT_MS = 15_000;
/** WebSocket 的 OPEN 状态码。 */
const WS_OPEN = 1;

/** 非文本消息段的占位文案：让模型知道「这里本来有东西」，而不是当成空消息。 */
const SEGMENT_PLACEHOLDER: Record<string, string> = {
    image: '[图片]',
    face: '[表情]',
    record: '[语音]',
    video: '[视频]',
    file: '[文件]',
    json: '[卡片]',
    music: '[音乐]',
};

/**
 * 把 OneBot 消息体归一成纯文本，并判断是否 @ 了机器人。
 *
 * SnowLuma 可能给**两种形状**：消息段数组（`message`）或带 CQ 码的字符串（`raw_message`），
 * 两种都要认，否则换一个 OneBot 实现对端就收不到内容了。
 *
 * @param message - 消息段数组（可能是字符串或 undefined）
 * @param raw - raw_message 字符串
 * @param selfId - 机器人自己的 QQ 号，用来识别 @
 */
function parseMessageBody(message: any, raw: any, selfId: string): { text: string; atMe: boolean } {
    let atMe = false;

    if (Array.isArray(message)) {
        const parts: string[] = [];
        for (const segment of message) {
            const type = String(segment?.type ?? '');
            if (type === 'text') {
                parts.push(String(segment?.data?.text ?? ''));
                continue;
            }
            if (type === 'at') {
                const qq = String(segment?.data?.qq ?? '');
                if (qq === 'all' || (selfId && qq === selfId)) atMe = true;
                parts.push(`@${segment?.data?.name ?? qq}`);
                continue;
            }
            // reply / poke 之类的段对模型没意义，直接丢掉。
            if (type === 'reply' || type === 'poke') continue;
            parts.push(SEGMENT_PLACEHOLDER[type] ?? `[${type}]`);
        }
        return { text: parts.join('').trim(), atMe };
    }

    const text = String(raw ?? '');
    const matched = /\[CQ:at,qq=(all|\d+)\]/i.exec(text);
    if (matched && (matched[1] === 'all' || (selfId && matched[1] === selfId))) atMe = true;
    return { text: text.replace(/\[CQ:[^\]]*\]/g, '').trim(), atMe };
}

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
    /** QQ 消息回调；由 BridgeService 注册，收到消息后在这里往上抛。 */
    private messageHandler: ((message: QqMessage) => void) | null = null;
    private lastMessageAt: number | null = null;
    /** 端点/令牌刷新后的回调；BridgeService 用它把端点落盘给独立的 MCP server 进程。 */
    private endpointHandler: ((endpoint: { httpUrl: string; token: string }) => void) | null = null;

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

    /** 注册 QQ 消息回调（后注册的覆盖先前的）。 */
    onMessage(handler: (message: QqMessage) => void): void {
        this.messageHandler = handler;
    }

    /** 注册端点刷新回调（后注册的覆盖先前的）。 */
    onEndpoint(handler: (endpoint: { httpUrl: string; token: string }) => void): void {
        this.endpointHandler = handler;
    }

    /** 当前生效的 OneBot HTTP 端点（发消息与调动作都走它）。 */
    getEndpoint(): { httpUrl: string; token: string } {
        return { httpUrl: this.httpUrl, token: this.token };
    }

    /** 机器人自己的账号信息（判断是否 @ 了自己、忽略自己的消息都要用）。 */
    getSelf(): { userId: string; nickname: string } | null {
        return this.self;
    }

    /** 最近一次收到 QQ 消息的时间戳。 */
    getLastMessageAt(): number | null {
        return this.lastMessageAt;
    }

    /**
     * 发一条 QQ 消息。
     *
     * 走 HTTP API 而不是 WS action：OneBot 的 HTTP 与 WS 是两套 token，
     * 本模块已经持有可用的 HTTP token（自动发现出来的），直接复用最省事。
     *
     * @returns 上游返回的 message_id（取不到时返回 null）。
     */
    async sendMessage(kind: 'private' | 'group', id: string, text: string): Promise<string | null> {
        const body = String(text ?? '');
        if (!body.trim()) throw new Error('消息内容为空，已跳过发送');

        const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
        const params = kind === 'group'
            ? { group_id: Number(id), message: body }
            : { user_id: Number(id), message: body };

        const res = await fetch(`${this.httpUrl}/${action}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`发送失败：HTTP ${res.status}`);

        const data: any = await res.json().catch(() => null);
        if (!data || data.status !== 'ok' || data.retcode !== 0) {
            throw new Error(`发送失败：${data?.status ?? '?'}/${data?.retcode ?? '?'} ${data?.wording ?? ''}`.trim());
        }
        return data?.data?.message_id === undefined ? null : String(data.data.message_id);
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
            this.emitEndpoint();
        } catch (error) {
            this.lastError = (error as Error)?.message ?? String(error);
        }
    }

    /** 把当前端点交给上层落盘（失败不影响连接本身）。 */
    private emitEndpoint(): void {
        if (!this.endpointHandler) return;
        try {
            this.endpointHandler(this.getEndpoint());
        } catch (error) {
            Logger.warn('[SnowLuma] 端点回调失败：', (error as Error)?.message ?? error);
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
        // 发现阶段失败但连接仍成功时也要落盘，否则独立进程拿不到端点。
        this.emitEndpoint();
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
            return;
        }

        if (message?.post_type === 'message') this.emitMessage(message);
    }

    /** 把一条 OneBot 消息事件归一化后交给上层（没注册回调时只记日志）。 */
    private emitMessage(event: any): void {
        const messageType = String(event?.message_type ?? '');
        if (messageType !== 'private' && messageType !== 'group') return;

        const selfId = String(this.self?.userId ?? event?.self_id ?? '');
        const userId = String(messageType === 'group' ? (event?.sender?.user_id ?? event?.user_id ?? '') : (event?.user_id ?? ''));
        const id = messageType === 'group' ? String(event?.group_id ?? '') : userId;
        // 群里优先用群名片，其次昵称；私聊只有昵称。
        const nickname = String((messageType === 'group' && event?.sender?.card) || event?.sender?.nickname || '');
        const { text, atMe } = parseMessageBody(event?.message, event?.raw_message, selfId);

        const message: QqMessage = {
            kind: messageType,
            id,
            userId,
            nickname,
            text,
            atMe,
            messageId: event?.message_id === undefined ? null : String(event.message_id),
            at: this.lastEventAt ?? Date.now(),
        };
        this.lastMessageAt = message.at;

        if (!this.messageHandler) {
            Logger.warn('[SnowLuma] 收到消息但没有处理者，已忽略');
            return;
        }
        try {
            this.messageHandler(message);
        } catch (error) {
            Logger.error('[SnowLuma] 处理消息失败：', (error as Error)?.message ?? error);
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
