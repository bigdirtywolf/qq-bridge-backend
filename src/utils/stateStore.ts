// 桥接运行态存储：允许名单、当前人格、DSH 会话映射、最近消息。
//
// 只落盘「运行状态」：人格正文始终以 roles/<角色名>.md 存在磁盘上（方便直接手改、
// 也方便前端导入导出），这里只记「当前启用哪个人格」和注入上限。
//
// 之所以要持久化会话映射：DSH 的 sessionId 建一次就够用，重启后端不该重新建会话，
// 否则 DSH 侧会堆一堆空会话，上下文也接不上。
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './log4js';

/** 最近消息的保留条数（前端只展示最近若干条，多了没必要）。 */
export const MAX_MESSAGES = 200;
/** 人格注入上限的默认值与可调范围，与参考实现保持一致。 */
export const DEFAULT_MAX_INJECT_CHARS = 6000;
export const MIN_MAX_INJECT_CHARS = 1000;
export const MAX_MAX_INJECT_CHARS = 20000;

/** 私聊/群聊允许名单。 */
export interface AllowConfig {
    private: string[]
    groups: string[]
    /** 名单为空时是否放行全部；默认 false（不放行），避免不知情时机器人对所有人开口。 */
    allowAllWhenEmpty: boolean
}

/** 人格的运行态：当前启用的角色名与注入上限。 */
export interface PersonaState {
    current: string | null
    maxInjectChars: number
}

/** 一条消息记录（进/出各一条）。 */
export interface BridgeMessage {
    at: number
    /** in=QQ 进来的，out=机器人发出去的。 */
    direction: 'in' | 'out'
    kind: 'private' | 'group'
    /** 私聊为对方 QQ 号，群聊为群号。 */
    id: string
    /** 私聊为对方昵称，群聊为「群号/发送者」。 */
    name: string
    text: string
    /** 是否由 DSH 生成（手动直发为 false）。 */
    viaDsh: boolean
}

/** 最近一次发现到的 OneBot HTTP 端点。 */
export interface OneBotEndpoint {
    httpUrl: string
    token: string
}

interface BridgeStateDoc {
    allow: AllowConfig
    persona: PersonaState
    /** 会话 key（private:123 / group:456）-> DSH sessionId。 */
    sessions: Record<string, string>
    messages: BridgeMessage[]
    /** 已开放的 QQ 动作名单；null=还没配置过（此时按默认安全子集算）。 */
    tools: string[] | null
    /** 独立的 MCP server 进程要复用这份端点/令牌，所以一并落盘。 */
    onebot: OneBotEndpoint | null
}

const STATE_DIR = path.resolve(__dirname, '../../state');
const STATE_FILE = path.join(STATE_DIR, 'bridge-state.json');

function defaultState(): BridgeStateDoc {
    return {
        allow: { private: [], groups: [], allowAllWhenEmpty: false },
        persona: { current: null, maxInjectChars: DEFAULT_MAX_INJECT_CHARS },
        sessions: {},
        messages: [],
        tools: null,
        onebot: null,
    };
}

/** 把任意输入收敛成字符串数组：去掉空白与重复项。 */
function toIdList(value: any): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const id = String(item ?? '').trim();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/** 收敛注入上限：非法输入退回默认值，合法值夹在可调范围内。 */
export function normalizeMaxInjectChars(value: any): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_MAX_INJECT_CHARS;
    return Math.min(MAX_MAX_INJECT_CHARS, Math.max(MIN_MAX_INJECT_CHARS, Math.round(num)));
}

export class StateStore {
    private doc: BridgeStateDoc

    constructor() {
        this.doc = this.load();
    }

    /** 读取状态文件；缺失或损坏时退回默认值（不抛错，桥接要能起来）。 */
    private load(): BridgeStateDoc {
        try {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const fallback = defaultState();
            return {
                allow: {
                    private: toIdList(raw?.allow?.private),
                    groups: toIdList(raw?.allow?.groups),
                    allowAllWhenEmpty: raw?.allow?.allowAllWhenEmpty === true,
                },
                persona: {
                    current: raw?.persona?.current ? String(raw.persona.current) : null,
                    maxInjectChars: normalizeMaxInjectChars(raw?.persona?.maxInjectChars),
                },
                sessions: raw?.sessions && typeof raw.sessions === 'object' ? { ...raw.sessions } : fallback.sessions,
                messages: Array.isArray(raw?.messages) ? raw.messages.filter((item: any) => item && item.text).slice(-MAX_MESSAGES) : [],
                // 缺字段时按「没配置过」处理（走默认安全子集），而不是当成「一个都不开」。
                tools: Array.isArray(raw?.tools) ? toIdList(raw.tools) : null,
                onebot: raw?.onebot?.httpUrl
                    ? { httpUrl: String(raw.onebot.httpUrl).replace(/\/+$/, ''), token: String(raw.onebot.token ?? '') }
                    : null,
            };
        } catch {
            return defaultState();
        }
    }

    /** 落盘；失败只记日志，不影响正在跑的桥接。 */
    save(): void {
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            fs.writeFileSync(STATE_FILE, JSON.stringify(this.doc, null, 4), 'utf8');
        } catch (error) {
            Logger.warn('[State] 状态落盘失败：', (error as Error)?.message ?? error);
        }
    }

    getAllow(): AllowConfig {
        return { private: [...this.doc.allow.private], groups: [...this.doc.allow.groups], allowAllWhenEmpty: this.doc.allow.allowAllWhenEmpty };
    }

    setAllow(allow: Partial<AllowConfig>): AllowConfig {
        this.doc.allow = {
            private: toIdList(allow?.private ?? this.doc.allow.private),
            groups: toIdList(allow?.groups ?? this.doc.allow.groups),
            allowAllWhenEmpty: (allow?.allowAllWhenEmpty ?? this.doc.allow.allowAllWhenEmpty) === true,
        };
        this.save();
        return this.getAllow();
    }

    getPersona(): PersonaState {
        return { ...this.doc.persona };
    }

    setPersona(persona: Partial<PersonaState>): PersonaState {
        this.doc.persona = {
            current: persona?.current === undefined ? this.doc.persona.current : (persona.current ? String(persona.current) : null),
            maxInjectChars: persona?.maxInjectChars === undefined
                ? this.doc.persona.maxInjectChars
                : normalizeMaxInjectChars(persona.maxInjectChars),
        };
        this.save();
        return this.getPersona();
    }

    /** 全部会话映射的浅拷贝。 */
    getSessions(): Record<string, string> {
        return { ...this.doc.sessions };
    }

    setSession(key: string, sessionId: string): void {
        this.doc.sessions[key] = sessionId;
        this.save();
    }

    removeSession(key: string): void {
        if (this.doc.sessions[key] === undefined) return;
        delete this.doc.sessions[key];
        this.save();
    }

    /** 记一条消息；超出上限时丢掉最旧的。 */
    pushMessage(message: BridgeMessage): void {
        this.doc.messages.push(message);
        if (this.doc.messages.length > MAX_MESSAGES) {
            this.doc.messages.splice(0, this.doc.messages.length - MAX_MESSAGES);
        }
        this.save();
    }

    /** 最近的消息（默认最近 50 条，按时间正序返回，前端好直接渲染）。 */
    getMessages(limit = 50): BridgeMessage[] {
        const count = Math.min(Math.max(Number(limit) || 50, 1), MAX_MESSAGES);
        return this.doc.messages.slice(-count);
    }

    clearMessages(): void {
        this.doc.messages = [];
        this.save();
    }

    /** 已开放的 QQ 动作名单；null 表示还没配置过（调用方应按默认安全子集处理）。 */
    getEnabledActions(): string[] | null {
        return this.doc.tools === null ? null : [...this.doc.tools];
    }

    setEnabledActions(list: string[] | null): void {
        this.doc.tools = list === null ? null : toIdList(list);
        this.save();
    }

    /**
     * 最近一次发现到的 OneBot HTTP 端点。
     *
     * 之所以要让后端把端点写进运行态：MCP server 是 DSH 另起的独立进程，拿不到后端内存里的
     * 令牌，只能从这份文件读。端点或令牌轮换时后端会立刻覆写，MCP server 每次调用前重读。
     */
    getOneBotEndpoint(): OneBotEndpoint | null {
        return this.doc.onebot ? { ...this.doc.onebot } : null;
    }

    setOneBotEndpoint(endpoint: OneBotEndpoint | null): void {
        const httpUrl = String(endpoint?.httpUrl ?? '').replace(/\/+$/, '');
        this.doc.onebot = httpUrl ? { httpUrl, token: String(endpoint?.token ?? '') } : null;
        this.save();
    }
}
