// DSH 连接管理：地址识别 → 鉴权 → 探活 → 事件流 → 会话收发。
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
//
// 收发消息的链路（与参考实现一致）：
//   ① `workspace/create`（幂等）拿到工作区 → ② `session/create` 复用或新建会话 →
//   ③ 在 mux 上按 `session/follow` 订阅该会话 → ④ `session/prompt` 投递用户消息 →
//   ⑤ 从会话事件里收集 `assistant/message` 文本，`turn/end` 表示回合结束 → ⑥ 回复到手。
//
// 注意 ④ 与 ⑤ 的顺序：会话事件可能比 prompt 的响应先到，所以**等待者必须先注册**，
// 否则会漏掉一个很快就结束的回合（表现为「QQ 上永远没有回复」）。
import * as fs from 'fs';
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
/** 单条会话流被服务端结束后的重新订阅延迟。 */
const SESSION_REOPEN_MS = 2_000;
/** `session/follow` 开场快照携带的历史事件条数（默认 50，调大只为看清上下文）。 */
const SNAPSHOT_MESSAGES = 50;
/** 等一次助手回复的默认超时。 */
const DEFAULT_REPLY_TIMEOUT_MS = 180_000;

/** 会话创建的工作目录（DSH 侧会把这个目录当作会话的 workspace）。 */
const SESSION_DIR = path.resolve(__dirname, '../../state/agents');

/**
 * DSH RPC 的 args 包装方式。
 *
 * DSH 0.1.2 起改为斜杠 endpoint + `{ args: { request } }` 信封，
 * `settings/describe` 不需要参数（null），未登记的走原样透传。
 */
const ARG_WRAPPERS: Record<string, string | null> = {
    'settings/describe': null,
    'session/list': '_request',
    'session/create': 'request',
    'session/prompt': 'request',
    'session/cancel': 'request',
    'session/selectModel': 'request',
    'session/rename': 'request',
    'session/follow': 'request',
    'workspace/create': 'request',
    'workspace/rename': 'request',
    'workspace/archiveSession': 'request',
    'agentPresets/list': null,
};

/** 一次「等助手回复」的等待者。 */
interface TurnWaiter {
    resolve: (text: string) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

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
    /** mux 是否已 open（open 之前发帧没有意义）。 */
    private muxOpen = false;
    private eventStream: DshEventStreamState = { status: 'idle', ready: false, lastError: null };
    /** $events 逻辑流的 streamId。 */
    private eventsStreamId: string | null = null;

    /** 会话 key（private:QQ号 / group:群号）-> DSH sessionId。 */
    private readonly sessions = new Map<string, string>();
    /** 期望订阅的会话：跨重连保留，重连后重放。 */
    private readonly desiredFollows = new Set<string>();
    /** sessionId -> streamId（用于判断重复订阅）。 */
    private readonly sessionStreams = new Map<string, string>();
    /** streamId -> sessionId（帧分发用）。 */
    private readonly streamToSession = new Map<string, string>();
    /** 每个会话每个回合收集到的助手文本：sessionId -> (turn -> text)。 */
    private readonly turnBuffers = new Map<string, Map<string, string>>();
    /** 等待回复的等待者：sessionId -> 等待者集合。 */
    private readonly waiters = new Map<string, Set<TurnWaiter>>();
    /** 工作区 id 缓存：所有 QQ 会话挂在同一个工作区下，DSH 界面里不会散落成「未分组」。 */
    private workspaceId: string | null = null;
    private replyTimeoutMs: number;

    constructor(options: DshOptions = {}, restoredSessions: Record<string, string> = {}) {
        this.options = options ?? {};
        // 自定义 baseUrl 优先，其次环境变量，最后留给自动识别。
        this.baseUrl = String(this.options.baseUrl || process.env.DSH_BASE_URL || '').replace(/\/+$/, '');
        this.replyTimeoutMs = Number(this.options.replyTimeoutMs) > 0 ? Number(this.options.replyTimeoutMs) : DEFAULT_REPLY_TIMEOUT_MS;
        for (const [key, sessionId] of Object.entries(restoredSessions ?? {})) {
            if (key && sessionId) this.sessions.set(key, String(sessionId));
        }
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
        this.rejectWaiters('DSH 连接已断开');
        this.desiredFollows.clear();
        this.turnBuffers.clear();
        this.workspaceId = null;
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

    /** 是否已经探活成功（可以收发消息）。 */
    isReady(): boolean {
        return this.ready && !this.stopped;
    }

    /** 会话映射的快照，供上层持久化。 */
    getSessions(): Record<string, string> {
        return Object.fromEntries(this.sessions);
    }

    /**
     * 走完「投一条用户消息 → 拿助手回复」的完整流程。
     *
     * @param key - 会话 key（private:QQ号 / group:群号）
     * @param text - 要投递的文本
     * @param timeoutMs - 等待回复的超时
     * @returns 助手回复文本（可能是空串：DSH 只做了「无话可说」的判断）
     */
    async chat(key: string, text: string, timeoutMs?: number): Promise<{ sessionId: string; text: string }> {
        const limit = timeoutMs && timeoutMs > 0 ? timeoutMs : this.replyTimeoutMs;

        let sessionId = await this.ensureSession(key);
        // 先注册等待者再投递：回合可能非常短，反过来的话会漏掉 turn/end。
        let waiter = this.createWaiter(sessionId, limit);
        try {
            await this.promptSession(sessionId, text);
        } catch (error) {
            const message = (error as Error)?.message ?? String(error);
            // DSH 重启 / 会话被归档后本地映射会失效：退役后重建一次，其余错误直接抛给上层。
            if (!/not[- ]?found/i.test(message)) {
                waiter.cancel();
                throw error;
            }
            Logger.warn(`[DSH] 会话 ${key} 在 DSH 侧已不存在，重建会话后重投`);
            this.retireSession(key);
            sessionId = await this.ensureSession(key);
            waiter.cancel();
            waiter = this.createWaiter(sessionId, limit);
            await this.promptSession(sessionId, text);
        }

        const reply = await waiter.promise;
        return { sessionId, text: reply };
    }

    /** 退役一个会话的本地映射与订阅（DSH 侧会话本身保留）。 */
    retireSession(key: string): void {
        const sessionId = this.sessions.get(key);
        if (!sessionId) return;
        this.sessions.delete(key);
        this.desiredFollows.delete(sessionId);
        this.sessionStreams.delete(sessionId);
        for (const [streamId, mapped] of this.streamToSession) {
            if (mapped === sessionId) this.streamToSession.delete(streamId);
        }
        this.turnBuffers.delete(sessionId);
        this.rejectWaiters('会话已退役', sessionId);
    }

    /** 复用或新建会话；同一 key 只会有一个会话。 */
    private async ensureSession(key: string): Promise<string> {
        if (this.stopped) throw new Error('DSH 连接已断开，请先在主页点「连接」');
        if (!this.ready) throw new Error(`DSH 未就绪（${this.lastError ?? '探活未通过'}），无法收发消息`);

        const cached = this.sessions.get(key);
        if (cached) {
            // 会话流可能已断（DSH 重启），follow 是幂等的，顺手补齐。
            this.follow(cached);
            return cached;
        }

        fs.mkdirSync(SESSION_DIR, { recursive: true });
        const workspaceId = await this.ensureWorkspace();
        const params: Record<string, any> = { workspaceId };
        if (this.options.agentPreset) params.agentPreset = this.options.agentPreset;

        const created = await this.call('session/create', params);
        const sessionId = String(created?.sessionId ?? '');
        if (!sessionId) throw new Error('DSH 未返回 sessionId');

        this.sessions.set(key, sessionId);
        await this.selectModel(sessionId);
        this.follow(sessionId);
        Logger.info(`[DSH] 新会话 ${key} -> ${sessionId}（preset ${this.options.agentPreset ?? '默认'}）`);
        return sessionId;
    }

    /** 创建工作区（幂等）：所有 QQ 会话挂在同一个工作区下。 */
    private async ensureWorkspace(): Promise<string> {
        if (this.workspaceId) return this.workspaceId;

        const value = await this.call('workspace/create', { path: SESSION_DIR });
        const workspaceId = String(value?.workspace?.workspaceId ?? '');
        if (!workspaceId) throw new Error('DSH 未返回 workspaceId');

        // 只有新建时才改名，避免每次连接都把用户改过的标题覆盖回去。
        const title = this.options.workspaceTitle ?? process.env.DSH_WORKSPACE_TITLE ?? '';
        if (value?.created && title) {
            try {
                await this.call('workspace/rename', { workspaceId, title });
            } catch (error) {
                Logger.warn('[DSH] 工作区改名失败：', (error as Error)?.message ?? error);
            }
        }
        this.workspaceId = workspaceId;
        return workspaceId;
    }

    /** 给会话钉住模型（best-effort）：失败只告警，DSH 自己的默认模型仍可用。 */
    private async selectModel(sessionId: string): Promise<void> {
        const provider = String(this.options.provider || process.env.DSH_PROVIDER || '');
        const model = String(this.options.model || process.env.DSH_MODEL || '');
        if (!provider || !model) return;

        const params: Record<string, any> = { sessionId, provider, model };
        const effort = this.options.reasoningEffort || process.env.DSH_REASONING_EFFORT;
        if (effort) params.reasoningEffort = effort;

        try {
            const value = await this.call('session/selectModel', params);
            const selected = value?.selected;
            Logger.info(`[DSH] 会话 ${sessionId} 模型 -> ${selected?.provider ?? provider}/${selected?.model ?? model}`);
        } catch (error) {
            Logger.warn('[DSH] 设置会话模型失败（沿用 DSH 默认模型）：', (error as Error)?.message ?? error);
        }
    }

    /** 投递一条用户消息（`mode: queue` 表示排队投递，不会打断正在跑的回合）。 */
    private async promptSession(sessionId: string, text: string): Promise<void> {
        await this.call('session/prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: String(text ?? '') }],
        });
    }

    /** 在 mux 上订阅一个会话的事件流（幂等）。 */
    private follow(sessionId: string): void {
        this.desiredFollows.add(sessionId);
        if (this.muxOpen) this.openSessionStream(sessionId);
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
                    this.rejectWaiters('DSH 不可用');
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

    /** 把旧 payload 包装成 DSH 新协议要求的 `{ args }`，并补新版必填字段。 */
    private wrapArgs(method: string, payload: Record<string, any>): any {
        const wrapper = ARG_WRAPPERS[method];
        if (wrapper === null) return { args: {} };

        const body = { ...(payload ?? {}) };
        // 新版 SessionPromptRequest 强制要求 requestId。
        if (method === 'session/prompt' && typeof body.requestId !== 'string') body.requestId = randomUUID();
        if (wrapper === undefined) return { args: body };
        return { args: { [wrapper]: body } };
    }

    /** 调一次 DSH RPC（POST /api/<endpoint>）。 */
    private async call(method: string, payload: Record<string, any> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
        const cookie = await this.ensureAuth();
        const endpoint = method.replace(/\./g, '/');
        const rpcId = randomUUID();

        const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({
                type: 'client-request',
                rpcId,
                method: endpoint,
                payload: this.wrapArgs(endpoint, payload),
            }),
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

    /** 连接 /api/remote.mux：一条 $events 逻辑流 + 每个会话一条 session/follow 流。 */
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
                this.muxOpen = true;
                this.eventStream.status = 'connected';
                this.updatedAt = Date.now();
                this.openEventsStream();
                // 重放**全部**期望订阅：DSH 一重启，会话事件不会自己回来。
                for (const sessionId of this.desiredFollows) this.openSessionStream(sessionId);
            });

            socket.addEventListener('message', (event: any) => this.handleMuxFrame(event));
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

    private sendFrame(frame: Record<string, any>): void {
        try {
            this.muxSocket?.send(JSON.stringify(frame));
        } catch (error) {
            this.handleMuxClose(`事件流发送失败：${(error as Error)?.message ?? error}`);
        }
    }

    /** 打开 $events 逻辑流（提问/审批等宿主级事件走这条）。 */
    private openEventsStream(): void {
        if (!this.muxOpen || this.eventsStreamId) return;
        const streamId = randomUUID();
        this.eventsStreamId = streamId;
        this.sendFrame({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } });
    }

    /** 打开一个会话的事件流（幂等：已订阅的会话不会重复开）。 */
    private openSessionStream(sessionId: string): void {
        if (!this.muxOpen || this.sessionStreams.has(sessionId)) return;
        const streamId = randomUUID();
        this.sessionStreams.set(sessionId, streamId);
        this.streamToSession.set(streamId, sessionId);
        this.sendFrame({
            type: 'open',
            streamId,
            endpoint: 'session/follow',
            payload: {
                args: {
                    request: {
                        address: { kind: 'session', sessionId },
                        maxMessages: SNAPSHOT_MESSAGES,
                    },
                },
            },
        });
    }

    /** mux 上收到的每一帧：先按 streamId 判断是 $events 还是某个会话。 */
    private handleMuxFrame(event: any): void {
        let frame: any;
        try {
            const raw = typeof event?.data === 'string' ? event.data : String(event?.data ?? '');
            frame = JSON.parse(raw);
        } catch {
            return;
        }
        if (!frame || typeof frame.type !== 'string' || typeof frame.streamId !== 'string') return;

        if (frame.streamId === this.eventsStreamId) {
            this.handleEventsFrame(frame);
            return;
        }

        const sessionId = this.streamToSession.get(frame.streamId);
        if (!sessionId) return;

        if (frame.type === 'item') {
            if (frame.value?.type === 'event') this.handleSessionEvent(sessionId, frame.value.event);
            // snapshot（开场快照）里含**历史**回合，绝不能喂给回合收集器，
            // 否则重连后会把早已结束的回合当成新回复发到 QQ 上。
            return;
        }
        if (frame.type === 'end' || frame.type === 'error') {
            this.streamToSession.delete(frame.streamId);
            this.sessionStreams.delete(sessionId);
            const code = frame.error?.code;
            if (code === 'session/not-found') {
                // 会话真的没了：取消订阅，让上层在下次发消息时重建。
                this.desiredFollows.delete(sessionId);
                this.turnBuffers.delete(sessionId);
                this.rejectWaiters('会话不存在', sessionId);
                return;
            }
            Logger.warn(`[DSH] 会话流已结束（${code ?? frame.type}）：${sessionId}，稍后重新订阅`);
            if (this.desiredFollows.has(sessionId)) {
                const timer = setTimeout(() => {
                    if (!this.stopped && this.desiredFollows.has(sessionId)) this.openSessionStream(sessionId);
                }, SESSION_REOPEN_MS);
                timer.unref?.();
            }
        }
    }

    /** $events 逻辑流：拿到 ready 才算订阅成功；断了要整条 mux 重连。 */
    private handleEventsFrame(frame: any): void {
        if (frame.type === 'item' && frame.value?.type === 'ready') {
            if (!this.eventStream.ready) {
                this.eventStream.ready = true;
                this.muxRetryMs = MIN_RETRY_MS;
                Logger.info('[DSH] 事件流已订阅（$events ready）');
            }
            return;
        }
        if (frame.type === 'end' || frame.type === 'error') {
            this.handleMuxClose(`事件流被结束：${frame.error?.code ?? frame.error?.message ?? 'unknown'}`);
        }
    }

    /**
     * 会话事件 → 回合文本 / 回合结束信号。
     *
     * 只认 `turn/start`、`assistant/message`、`turn/end`：
     * `assistant/chunk`（流式分块）必须忽略 —— `assistant/message` 已经是完整组装文本，
     * 两者都累加会导致回复文本翻倍（参考实现踩过的坑）。
     */
    private handleSessionEvent(sessionId: string, event: any): void {
        const type = String(event?.type ?? '');
        if (type !== 'turn/start' && type !== 'assistant/message' && type !== 'turn/end') return;

        const turn = String(event?.data?.turn ?? '');
        if (!turn) return;

        let buffers = this.turnBuffers.get(sessionId);
        if (!buffers) {
            buffers = new Map<string, string>();
            this.turnBuffers.set(sessionId, buffers);
        }

        if (type === 'turn/start') {
            buffers.set(turn, '');
            return;
        }
        if (type === 'assistant/message') {
            // 没有匹配的 turn/start（比如流中途接上）就放弃这条，避免拼出半截文本。
            if (buffers.get(turn) === undefined) return;
            const parts: string[] = [];
            for (const block of event?.data?.message?.content ?? []) {
                if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
            }
            buffers.set(turn, (buffers.get(turn) ?? '') + parts.join(''));
            return;
        }

        // turn/end：交出这一回合的文本，并唤醒等待者。
        const text = buffers.get(turn) ?? '';
        buffers.delete(turn);
        if (buffers.size === 0) this.turnBuffers.delete(sessionId);
        this.resolveWaiters(sessionId, text);
    }

    /** 注册一个等待助手回复的等待者。 */
    private createWaiter(sessionId: string, timeoutMs: number): { promise: Promise<string>; cancel: () => void } {
        let waiter: TurnWaiter;
        const promise = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeWaiter(sessionId, waiter);
                reject(new Error(`等待 DSH 回复超时（${timeoutMs}ms）`));
            }, timeoutMs);
            timer.unref?.();

            waiter = { resolve, reject, timer };
            const set = this.waiters.get(sessionId) ?? new Set<TurnWaiter>();
            set.add(waiter);
            this.waiters.set(sessionId, set);
        });

        return {
            promise,
            cancel: () => {
                clearTimeout(waiter?.timer);
                this.removeWaiter(sessionId, waiter);
            },
        };
    }

    /** 结束一个回合：唤醒该会话的等待者。 */
    private resolveWaiters(sessionId: string, text: string): void {
        const set = this.waiters.get(sessionId);
        if (!set?.size) return;

        const [waiter] = set;
        this.removeWaiter(sessionId, waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(text);
    }

    private removeWaiter(sessionId: string, waiter: TurnWaiter | undefined): void {
        const set = this.waiters.get(sessionId);
        if (!set || !waiter) return;
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(sessionId);
    }

    /** 拒绝所有等待者（连接断开 / 会话退役时），避免调用方一直挂着。 */
    private rejectWaiters(reason: string, only?: string): void {
        const targets = only ? [only] : [...this.waiters.keys()];
        for (const sessionId of targets) {
            const set = this.waiters.get(sessionId);
            if (!set) continue;
            for (const waiter of set) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error(reason));
            }
            this.waiters.delete(sessionId);
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
        this.muxOpen = false;
        this.eventsStreamId = null;
        this.sessionStreams.clear();
        this.streamToSession.clear();
        if (!socket) return;
        try {
            socket.close();
        } catch {
            // 已经断了。
        }
    }
}
