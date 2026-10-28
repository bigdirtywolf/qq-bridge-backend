// SnowLuma（OneBot v11）连接自发现：解决「换 QQ 账号后 token 变了，连接就 401」的问题。
//
// 背景（对照参考实现实测确认）：
//   SnowLuma 的 OneBot 配置是**按账号分文件**的：<SnowLuma>/config/onebot_<QQ号>.json，
//   每个账号有各自的 accessToken，而且 **HTTP 与 WebSocket 是两个不同的 token、端口也不同**
//   （默认 HTTP 3000 / WS 3001）。换账号登录后旧 token 直接 401（retcode 1401），
//   于是任何把 token 硬编码在配置里的程序全部失效。
//
// 本模块的做法：**不猜**，而是拿候选 token 真去问一次 get_login_info，谁通就用谁，
// 并把当前账号的 WS 信息一并回报。候选来源：
//   1) 显式传入的 token / 环境变量；
//   2) 配置里已填的 token；
//   3) SnowLuma config 目录下所有 onebot_*.json 里的 token（真实来源）。
import * as fs from 'fs';
import * as path from 'path';
import { SnowLumaOptions } from '../dto/ConnectionDTO';

export { SnowLumaOptions };

/** OneBot 网络端点。HTTP 与 WS 各一份，token 与端口都可能不同。 */
export interface OneBotEndpoint {
    token: string;
    host: string;
    port: number;
}

/** 单个 QQ 账号的 OneBot 配置。 */
export interface OneBotAccount {
    uin: string;
    file: string;
    http: OneBotEndpoint | null;
    ws: OneBotEndpoint | null;
}

/** 一次发现的结果。 */
export interface SnowLumaDiscoveryResult {
    ok: boolean;
    token?: string;
    baseUrl?: string;
    self?: any;
    source?: string;
    wsToken?: string | null;
    wsUrl?: string | null;
    tried?: Array<Record<string, any>>;
    error?: string;
}

/**
 * SnowLuma 主目录的常见位置。
 *
 * 同时接受两种 cfg 形状（踩过坑：图形界面传的是「窄对象」，没有 snowluma 这一层，
 * 于是 homeDir 被忽略、per-account token 一个都扫不到）：
 *   - 完整配置：{ snowluma: { homeDir, launcherPath, ... } }
 *   - 窄对象：  { homeDir, launcherPath, ... }
 */
export function snowLumaHomeCandidates(options: SnowLumaOptions = {}): string[] {
    const out: string[] = [];
    const push = (p?: string) => {
        if (p && !out.includes(p)) out.push(p);
    };
    // 经接口平台连接时，端点与令牌都由平台提供：绝不能去 SnowLuma 目录里找令牌，
    // 否则自愈会拿到 SnowLuma 的真实端点、绕过平台直连。
    if (options.viaPlatform === true) return out;
    if (options.homeDir) push(String(options.homeDir));
    if (options.launcherPath) push(path.dirname(String(options.launcherPath)));
    if (process.env.SNOWLUMA_HOME) push(process.env.SNOWLUMA_HOME);
    return out;
}

/**
 * 从 SnowLuma 的 per-account 配置里读出候选端点。
 *
 * 重要：**HTTP 与 WebSocket 是两个不同的 token**（各自的 server 配置里各有一份），
 * 本进程收事件走 WS、发消息/查询走 HTTP，所以两边都要能取到。
 *
 * @returns 按 QQ 号排序的账号列表。
 */
export function readOneBotTokens(homeDir: string): OneBotAccount[] {
    const dir = path.join(homeDir, 'config');
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const out: OneBotAccount[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;

        const matched = /^onebot_(\d+)\.json$/i.exec(entry.name);
        if (!matched) continue;

        try {
            const file = path.join(dir, entry.name);
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            const networks = doc?.networks ?? {};
            const http = Array.isArray(networks.httpServers) ? networks.httpServers[0] : null;
            const ws = Array.isArray(networks.wsServers) ? networks.wsServers[0] : null;

            out.push({
                uin: matched[1],
                file,
                http: http
                    ? {
                        token: String(http.accessToken ?? ''),
                        host: http.host || '127.0.0.1',
                        port: Number(http.port) || 3000,
                    }
                    : null,
                ws: ws
                    ? {
                        token: String(ws.accessToken ?? ''),
                        host: ws.host || '127.0.0.1',
                        port: Number(ws.port) || 3001,
                    }
                    : null,
            });
        } catch {
            // 单个文件坏了不影响其它账号。
        }
    }

    return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 试一次 get_login_info；成功返回 data，失败返回失败原因。 */
async function probe(baseUrl: string, token: string, timeoutMs: number) {
    try {
        const res = await fetch(`${baseUrl}/get_login_info`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: '{}',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { ok: false, status: res.status };

        const body: any = await res.json().catch(() => ({}));
        if (body.status !== 'ok' || body.retcode !== 0) {
            return { ok: false, status: res.status, retcode: body.retcode, wording: body.wording };
        }
        return { ok: true, data: body.data };
    } catch (error) {
        return { ok: false, error: (error as Error)?.message ?? String(error) };
    }
}

/**
 * 自动找出一条**能用**的连接（token + baseUrl + 账号信息）。
 *
 * 候选顺序：显式配置优先（尊重用户选择），然后才是 per-account 文件里的其它账号。
 */
export async function discoverSnowLumaConnection(options: {
    options?: SnowLumaOptions;
    baseUrl?: string | null;
    token?: string | null;
    homeDirs?: string[] | null;
    timeoutMs?: number;
} = {}): Promise<SnowLumaDiscoveryResult> {
    const { options: sl = {}, timeoutMs = 6000 } = options;
    const base = String(
        options.baseUrl || process.env.SNOWLUMA_HTTP_URL || sl.httpUrl || 'http://127.0.0.1:3000',
    ).replace(/\/+$/, '');
    const homes = options.homeDirs ?? snowLumaHomeCandidates(sl);
    const explicit = options.token || process.env.SNOWLUMA_TOKEN || sl.accessToken || '';

    const candidates: Array<{ token: string; source: string; url: string }> = [];
    const seen = new Set<string>();
    const add = (token: string, source: string, url: string) => {
        const key = `${url}|${token}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ token, source, url });
    };

    if (explicit) add(explicit, 'config/env', base);

    // per-account 文件：同时收 HTTP token（工具用）与 WS 信息（本进程收事件用）。
    // 两个 token 不同、端口也各自记录，不能混用。
    const wsInfo = new Map<string, { token: string; url: string }>();
    for (const home of homes) {
        for (const account of readOneBotTokens(home)) {
            if (account.http) {
                add(account.http.token, `onebot_${account.uin}.json`, `http://${account.http.host}:${account.http.port}`);
            }
            if (account.ws?.token) {
                wsInfo.set(account.uin, {
                    token: account.ws.token,
                    url: `ws://${account.ws.host}:${account.ws.port}`,
                });
            }
        }
    }
    if (!explicit && candidates.length === 0) add('', 'no-token', base);

    const tried: Array<Record<string, any>> = [];
    for (const candidate of candidates) {
        const result = await probe(candidate.url, candidate.token, timeoutMs);
        tried.push({
            source: candidate.source,
            url: candidate.url,
            token: candidate.token ? `${candidate.token.slice(0, 4)}…` : '(空)',
            ok: result.ok,
            status: (result as any).status,
            wording: (result as any).wording,
        });

        if (result.ok) {
            // 找到有效 HTTP token 后，把**同一个账号**的 WS 信息也带回去：
            // 收事件走 WebSocket，用另一个 token、另一个端口 —— 只修 HTTP 的话 WS 仍然连不上。
            const uin = /onebot_(\d+)\.json/.exec(candidate.source)?.[1] ?? String((result as any).data?.user_id ?? '');
            const ws = wsInfo.get(uin) ?? null;

            return {
                ok: true,
                token: candidate.token,
                baseUrl: candidate.url,
                self: (result as any).data,
                source: candidate.source,
                wsToken: ws?.token ?? null,
                wsUrl: ws?.url ?? null,
                tried,
            };
        }
    }

    const last = tried[tried.length - 1];
    return {
        ok: false,
        tried,
        baseUrl: base,
        error: last?.status === 401
            ? '所有候选 token 都被拒绝（401）。当前账号的 token 可能还没写进 SnowLuma 的 config：'
                + '请确认 SnowLuma 已登录目标 QQ，且 OneBot HTTP 服务已开启。'
            : `连不上 OneBot HTTP API（${base}）：${last?.wording ?? last?.status ?? '未知错误'}`,
    };
}
