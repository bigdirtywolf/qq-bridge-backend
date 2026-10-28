// DSH 连接管理：地址识别 → 鉴权 → 探活 → 事件流。
//
// 三件事都必须做对，否则「连上了」是个假象：
//   1. **地址**：DSH 桌面版 0.2.1 起每次启动换随机回环端口，写死 19387/3080 都会连不上，
//      所以留空时走 {@link resolveDshBaseUrl} 自动识别。
//   2. **鉴权**：DSH 默认对所有请求回 401。没有凭据时连「探活」都做不了。
//      主路径是用持久化密钥**离线铸造** Cookie（不依赖启动 token、不随 DSH 重启失效）。
//   3. **探活**：`settings/describe` 是权威的「DSH 是否可用」信号。它很忙时偶尔一次
//      没及时回应是常态，所以连续失败 threshold 次才判定不可用，避免刷误报。
//
// 另外开一条 `/api/remote.mux` 事件流：探活只能证明「RPC 通」，事件流才证明
// 「事件通道通」——两者是这条链路的两个半边。
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Logger } from '../utils/log4js';
import { requireWebSocket } from '../utils';
import { ConnectionStatus, DshAuthStrategy, DshEventStreamState, DshOptions, DshState } from '../dto/ConnectionDTO';
import { dshHomeDir, resolveDshBaseUrl } from '../utils/dshEndpoint';
import {
    MINTED_COOKIE_LIFETIME_MS,
    MINTED_COOKIE_REFRESH_MARGIN_MS,
    discoverDshLaunchToken,
    isLoopbackBase,
    mintBrowserSessionCookie,
    readBrowserSessionSecret,
} from '../utils/dshAuth';

/** 探活间隔。 */
const PROBE_INTERVAL_MS = 5_000;
/** 单次 RPC 超时。 */
const RPC_TIMEOUT_MS = 15_000;
/** 连续失败多少次才判定 DSH 不可用（避免忙碌时的一次抖动造成误报）。 */
const FAILURE_THRESHOLD = 2;
/** 事件流重连退避的起止间隔。 */
const MIN_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;

export class DshManager {
    private readonly options: DshOptions;
    private baseUrl: string;
    private baseUrlAuto = false;
    private reachable = false;
    private cookie = '';
    private cookieExpiresAt = 0;
    private authStrategy: DshAuthStrategy = 'none';

    private status: ConnectionStatus = 'idle';
    private ready = false;
    private failures = 0;
    private lastError: string | null = null;
    private lastCheckAt: number | null = null;
    private updatedAt = Date.now();

    private stopped = true;
    private connecting = false;
    private probeTimer: NodeJS.Timeout | null = null;
    private muxRetryTimer: NodeJS.Timeout | null = null;
    private muxRetryMs = MIN_RETRY_MS;
    private muxSocket: any = null;
    private eventStream: DshEventStreamState = { status: 'idle', ready: false, lastError: null };

    constructor(options: DshOptions = {}) {
        this.options = options ?? {};
        this.baseUrl = String(this.options.baseUrl || process.env.DSH_BASE_URL || '').replace(/\/+$/, '');
    }

    /** 开始连接：识别地址 → 鉴权探活 → 开事件流，并定期复检。 */
    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        Logger.info('[DSH] 开始连接');
        void this.bootstrap();

        this.probeTimer = setInterval(() => void this.probe(), PROBE_INTERVAL_MS);
        this.probeTimer.unref?.();
    }

    /** 停止连接并清理所有定时器。 */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.probeTimer) clearInterval(this.probeTimer);
        if (this.muxRetryTimer) clearTimeout(this.muxRetryTimer);
        this.probeTimer = null;
        this.muxRetryTimer = null;

        this.closeMux();
        this.eventStream = { status: 'idle', ready: false, lastError: null };
        this.status = 'idle';
        this.ready = false;
        this.updatedAt = Date.now();
        Logger.info('[DSH] 已停止');
    }

    /** 当前连接状态快照。 */
    getState(): DshState {
        return {
            status: this.status,
            baseUrl: this.baseUrl,
            auto: this.baseUrlAuto,
            reachable: this.reachable,
            authStrategy: this.authStrategy,
            ready: this.ready,
            eventStream: { ...this.eventStream },
            lastError: this.lastError,
            lastCheckAt: this.lastCheckAt,
            updatedAt: this.updatedAt,
        };
    }

    private async bootstrap(): Promise<void> {
        if (this.stopped || this.connecting) return;
        this.connecting = true;
        this.status = 'connecting';
        this.updatedAt = Date.now();
        try {
            await this.locate();
            await this.probe();
        } finally {
            this.connecting = false;
            this.updatedAt = Date.now();
        }
    }

    /** 识别基址；端口变了必须让旧 Cookie 失效（Cookie 名与签名都绑定 host:port）。 */
    private async locate(): Promise<void> {
        try {
            const resolved = await resolveDshBaseUrl(this.options.baseUrl || process.env.DSH_BASE_URL || '');
            this.reachable = resolved.reachable;
            if (resolved.url !== this.baseUrl) {
                this.baseUrl = resolved.url;
                this.invalidateAuth();
                Logger.info(`[DSH] 已识别基址：${this.baseUrl}${resolved.discovered ? '（动态发现）' : ''}`);
            }
            this.baseUrlAuto = resolved.auto;
            if (!resolved.reachable) this.lastError = `DSH 端口不可连（${this.baseUrl}），可能没在运行或换了端口`;
        } catch (error) {
            this.lastError = (error as Error)?.message ?? String(error);
        }
    }

    /** 探活：settings/describe 成功即认为 DSH 可用。 */
    private async probe(): Promise<void> {
        if (this.stopped) return;
        // 未识别到可用端口时定期重新识别：DSH 可能刚起来，或换了随机端口。
        if (!this.reachable) await this.locate();

        this.lastCheckAt = Date.now();
        try {
            await this.call('settings.describe');
            this.failures = 0;
            this.lastError = null;
            if (!this.ready) {
                this.ready = true;
                this.status = 'connected';
                Logger.info(`[DSH] 已就绪：${this.baseUrl}（鉴权 ${this.authStrategy}）`);
                this.openEventStream();
            }
        } catch (error) {
            this.failures += 1;
            this.lastError = (error as Error)?.message ?? String(error);
            if (this.failures === 1) {
                Logger.warn('[DSH] 探活失败 1 次：', this.lastError);
            }
            // 连续失败到阈值才判定不可用：同时把状态与事件流拉回断开，
            // 否则连接不上时会一直停在「连接中」。恢复由下一次探活成功驱动。
            if (this.failures >= FAILURE_THRESHOLD && this.status !== 'disconnected') {
                const wasReady = this.ready;
                this.ready = false;
                this.status = 'disconnected';
                Logger.error(`[DSH] ⚠️ 不可用（连续 ${this.failures} 次探活失败）：${this.lastError}`);
                if (wasReady) {
                    this.closeMux();
                    this.eventStream = { status: 'disconnected', ready: false, lastError: 'DSH 不可用' };
                }
            }
        } finally {
            this.updatedAt = Date.now();
        }
    }

    /**
     * 取一个可用的会话 Cookie。
     *
     * 优先级：离线铸造（不依赖启动日志、不随 DSH 重启失效）→ 启动 token 交换。
     */
    private async ensureAuth(): Promise<string> {
        if (this.cookie && Date.now() < this.cookieExpiresAt - MINTED_COOKIE_REFRESH_MARGIN_MS) {
            return this.cookie;
        }
        this.invalidateAuth();

        // 铸造只对回环地址成立：签名密钥取自本机 DSH_HOME，远程 DSH 用的是另一份密钥。
        const secret = readBrowserSessionSecret();
        if (secret !== null && isLoopbackBase(this.baseUrl)) {
            this.cookie = mintBrowserSessionCookie(this.baseUrl, secret);
            this.cookieExpiresAt = Date.now() + MINTED_COOKIE_LIFETIME_MS;
            this.authStrategy = 'minted';
            return this.cookie;
        }

        const token = this.options.authToken || process.env.DSH_AUTH_TOKEN || discoverDshLaunchToken();
        if (!token) {
            this.authStrategy = 'none';
            throw new Error(
                `DSH 鉴权不可用：读不到 ${path.join(dshHomeDir(), '.credentials.yaml')} 里的签名密钥，`
                + '也没有可用的 launch token（请确认 DSH_HOME 指向真正的 .dsh 目录）',
            );
        }
        // launch token 是**进程启动凭据**，交换时只能放进 URL 查询串，绝不能发往非回环地址。
        if (this.options.allowRemote !== true && !isLoopbackBase(this.baseUrl)) {
            throw new Error(`拒绝把 DSH 启动 token 发往非本机地址（${this.baseUrl}）：那是进程启动凭据，只应交给 127.0.0.1`);
        }

        const url = new URL(this.baseUrl);
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        url.searchParams.set('token', token);
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        const setCookie = res.headers.get('set-cookie');
        await res.body?.cancel();
        if (!setCookie) throw new Error(`DSH token 交换失败：HTTP ${res.status}`);

        this.cookie = setCookie.split(';')[0].trim();
        this.cookieExpiresAt = Date.now() + MINTED_COOKIE_LIFETIME_MS;
        this.authStrategy = 'token';
        return this.cookie;
    }

    private invalidateAuth(): void {
        this.cookie = '';
        this.cookieExpiresAt = 0;
        this.authStrategy = 'none';
    }

    /** 调一次 DSH RPC（POST /api/<endpoint>）。 */
    private async call(method: string, payload: Record<string, any> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
        const cookie = await this.ensureAuth();
        const endpoint = method.replace(/\./g, '/');
        const rpcId = randomUUID();

        const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: payload ?? {} } }),
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 401) {
            // 铸造出来的 Cookie 也可能被拒（密钥轮换/非本机密钥），下次退回 token 交换。
            this.invalidateAuth();
            throw new Error('HTTP 401（鉴权失败）');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body: any = await res.json().catch(() => null);
        if (!body || body.type !== 'server-response' || !body.result) {
            throw new Error('DSH 返回了非预期的响应');
        }
        if (!body.result.ok) {
            const { code, message } = body.result.error ?? {};
            throw new Error(`${endpoint} 失败：${code ?? 'unknown'} ${message ?? ''}`.trim());
        }
        return body.result.value;
    }

    private openEventStream(): void {
        if (this.stopped || this.muxSocket || this.eventStream.status === 'connecting') return;
        void this.runEventStream();
    }

    /** 连接 /api/remote.mux 并订阅 $events，直到收到 ready 帧。 */
    private async runEventStream(): Promise<void> {
        try {
            const cookie = await this.ensureAuth();
            const url = new URL('/api/remote.mux', this.baseUrl);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

            const Impl = requireWebSocket();
            const socket = new Impl(url.toString(), { headers: { cookie } });
            this.muxSocket = socket;
            this.eventStream = { status: 'connecting', ready: false, lastError: null };
            this.updatedAt = Date.now();

            socket.addEventListener('open', () => {
                this.eventStream.status = 'connected';
                this.updatedAt = Date.now();
                try {
                    socket.send(JSON.stringify({
                        type: 'open',
                        streamId: randomUUID(),
                        endpoint: '$events',
                        payload: { args: {} },
                    }));
                } catch (error) {
                    this.handleMuxClose(`事件流订阅发送失败：${(error as Error)?.message ?? error}`);
                }
            });

            socket.addEventListener('message', (event: any) => {
                let message: any;
                try {
                    message = JSON.parse(typeof event?.data === 'string' ? event.data : String(event?.data ?? ''));
                } catch {
                    return;
                }
                if (message?.type === 'item' && message?.value?.type === 'ready') {
                    if (!this.eventStream.ready) {
                        this.eventStream.ready = true;
                        this.muxRetryMs = MIN_RETRY_MS;
                        Logger.info('[DSH] 事件流已订阅（$events ready）');
                    }
                } else if (message?.type === 'end' || message?.type === 'error') {
                    this.handleMuxClose(`事件流被结束：${message?.error?.code ?? message?.error?.message ?? 'unknown'}`);
                }
            });

            socket.addEventListener('close', () => this.handleMuxClose('事件流已关闭'));
            socket.addEventListener('error', () => this.handleMuxClose('事件流连接失败'));
        } catch (error) {
            this.eventStream = {
                status: 'disconnected',
                ready: false,
                lastError: (error as Error)?.message ?? String(error),
            };
            this.updatedAt = Date.now();
            this.scheduleMuxRetry();
        }
    }

    private handleMuxClose(reason: string): void {
        // error 之后通常紧跟 close：第一次处理时已把 socket 置空，第二次直接忽略。
        if (!this.muxSocket) return;
        this.closeMux();

        this.eventStream = { status: 'disconnected', ready: false, lastError: reason };
        this.updatedAt = Date.now();
        Logger.warn(`[DSH] ${reason}`);
        this.scheduleMuxRetry();
    }

    private scheduleMuxRetry(): void {
        if (this.stopped || this.muxRetryTimer) return;
        const delay = this.muxRetryMs;
        this.muxRetryMs = Math.min(MAX_RETRY_MS, this.muxRetryMs * 2);
        this.muxRetryTimer = setTimeout(() => {
            this.muxRetryTimer = null;
            this.openEventStream();
        }, delay);
        this.muxRetryTimer.unref?.();
    }

    private closeMux(): void {
        const socket = this.muxSocket;
        this.muxSocket = null;
        if (!socket) return;
        try {
            socket.close();
        } catch {
            // 已经断了。
        }
    }
}
