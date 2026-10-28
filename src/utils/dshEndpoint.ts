// DSH Web API 地址的自动识别。
//
// 事实（对照 DSH 桌面版安装包与实测）：
//   · 命令行版 `dsh web` 默认监听 3080；
//   · 桌面版早期写死 19387；
//   · **桌面版 0.2.1 起每次启动监听一个随机回环端口**，不再写死。
//
// 规则：配置里 **显式填写** dsh.baseUrl 时一律照用；留空时自动识别：
//   1. 检测到桌面版 → 候选 19387、3080，否则 3080、19387；
//   2. 按顺序试 TCP 连接，第一个能连上的胜出；
//   3. 都连不上时**动态发现**：查 DSH 桌面版进程正在监听的回环端口
//      （macOS 用 lsof，Windows 用 netstat + tasklist），
//      再用未登录请求的 401 特征文字（"dsh web authentication required"）确认确实是 DSH 才采用；
//   4. 仍然没有就用第一个候选（DSH 还没起来时先按它重试，不可用期间会定期重新识别）。
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import * as http from 'http';
import { execFile } from 'child_process';

/** 命令行版 `dsh web` 默认端口。 */
export const DSH_CLI_PORT = 3080;
/** 桌面版早期写死的端口。 */
export const DSH_DESKTOP_PORT = 19387;

/** DSH home：凭据文件与（历史）启动日志都在这里。 */
export function dshHomeDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** 是否装了 DSH 桌面版；返回桌面版版本号或 null。只读 runtime.json / Info.plist，不碰凭据。 */
export function detectDshDesktop(env: NodeJS.ProcessEnv = process.env): string | null {
    const base = path.join(dshHomeDir(env), 'dsh-runtimes');
    try {
        for (const dir of fs.readdirSync(base)) {
            try {
                const doc = JSON.parse(fs.readFileSync(path.join(base, dir, 'runtime.json'), 'utf8'));
                if (doc.desktopVersion) return String(doc.desktopVersion);
            } catch {
                // 单个 runtime 目录坏了不影响其它。
            }
        }
    } catch {
        // 没有 dsh-runtimes 目录即视为非桌面版（macOS 上桌面版没有这个目录）。
    }
    if (process.platform === 'darwin') {
        try {
            const app = env.DSH_DESKTOP_APP || '/Applications/DeepSeek Harness.app';
            const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
            const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
            if (version) return String(version);
        } catch {
            // 没装桌面版。
        }
    }
    return null;
}

/** 候选地址（按优先级）。configured 非空时只有它一个。 */
export function dshBaseUrlCandidates(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
    const value = String(configured ?? '').trim();
    if (value) return [value.replace(/\/+$/, '')];

    const cli = `http://127.0.0.1:${DSH_CLI_PORT}`;
    const desktop = `http://127.0.0.1:${DSH_DESKTOP_PORT}`;
    return detectDshDesktop(env) ? [desktop, cli] : [cli, desktop];
}

/** 端口是否可连（只探 TCP，不发请求）。 */
function portOpen(url: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            resolve(false);
            return;
        }
        const socket = net.connect({
            host: parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname,
            port: Number(parsed.port) || 80,
        });
        const done = (value: boolean) => {
            try {
                socket.destroy();
            } catch {
                // 已断开。
            }
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
        execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            resolve(error && !stdout ? '' : String(stdout ?? ''));
        });
    });
}

/** 从 `lsof -Fn` 输出里取回环监听端口。 */
export function parseLsofPorts(text: string): number[] {
    const out = new Set<number>();
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const matched = /^n(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(line.trim());
        if (matched) out.add(Number(matched[1]));
    }
    return [...out];
}

/** 从 Windows `netstat -ano -p TCP` 输出里取指定 PID 的回环监听端口。 */
export function parseNetstatPorts(text: string, pids: string[]): number[] {
    const want = new Set(pids.map(String));
    const out = new Set<number>();
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const matched = /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (matched && want.has(matched[2])) out.add(Number(matched[1]));
    }
    return [...out];
}

/** 从 `tasklist /FO CSV /NH` 输出里取 DSH 桌面版进程的 PID。 */
export function parseTasklistPids(text: string): string[] {
    const out: string[] = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const matched = /^"(DeepSeek Harness[^"]*\.exe)","(\d+)"/i.exec(line.trim());
        if (matched) out.push(matched[2]);
    }
    return out;
}

// 控制台会定期刷新状态：默认实现缓存 10 秒，避免频繁起 lsof / netstat 进程。
let portCache: { at: number; ports: number[] } = { at: 0, ports: [] };
const PORT_CACHE_MS = 10_000;

/** DSH 桌面版进程正在监听的回环端口（取不到返回 []）。只读系统信息，不碰 DSH 的任何文件。 */
export async function listDesktopListenPorts(timeoutMs = 3000): Promise<number[]> {
    if (Date.now() - portCache.at < PORT_CACHE_MS) return portCache.ports;

    const ports = await listDesktopListenPortsUncached(timeoutMs);
    portCache = { at: Date.now(), ports };
    return ports;
}

async function listDesktopListenPortsUncached(timeoutMs: number): Promise<number[]> {
    try {
        if (process.platform === 'darwin') {
            const text = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'DeepSeek', '-Fn'], timeoutMs);
            return parseLsofPorts(text);
        }
        if (process.platform === 'win32') {
            const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
            const pids = parseTasklistPids(await run(path.join(sys32, 'tasklist.exe'), ['/FO', 'CSV', '/NH'], timeoutMs));
            if (!pids.length) return [];
            return parseNetstatPorts(await run(path.join(sys32, 'netstat.exe'), ['-ano', '-p', 'TCP'], timeoutMs), pids);
        }
    } catch {
        // 系统命令不可用（权限/缺失）时静默放弃。
    }
    return [];
}

/** 未登录请求的特征：DSH 对没有凭据的请求回 401 + 固定提示文字。用它确认端口确实是 DSH。 */
export function looksLikeDsh(url: string, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        let parsed: URL;
        try {
            parsed = new URL('/', url);
        } catch {
            resolve(false);
            return;
        }
        const req = http.get(
            {
                host: parsed.hostname,
                port: parsed.port,
                path: '/',
                timeout: timeoutMs,
                headers: { accept: 'text/plain' },
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    if (body.length < 4096) body += chunk;
                });
                res.on('end', () => resolve(res.statusCode === 401 && /dsh web authentication required/i.test(body)));
            },
        );
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}

/** 一次地址识别的结果。 */
export interface DshBaseUrlResult {
    url: string;
    /** true 表示配置留空、由本模块识别出来的。 */
    auto: boolean;
    reachable: boolean;
    /** true 表示靠「扫监听端口 + 401 特征」动态发现出来的（而非候选列表命中）。 */
    discovered?: boolean;
    candidates: string[];
}

/** 解析出可用的 DSH 基址。 */
export async function resolveDshBaseUrl(
    configured?: string | null,
    { env = process.env, timeoutMs = 800, discover = true } = {},
): Promise<DshBaseUrlResult> {
    const candidates = dshBaseUrlCandidates(configured, env);
    const auto = !String(configured ?? '').trim();

    for (const url of candidates) {
        if (await portOpen(url, timeoutMs)) {
            return { url, auto, reachable: true, candidates };
        }
    }
    if (auto && discover) {
        for (const port of await listDesktopListenPorts()) {
            const url = `http://127.0.0.1:${port}`;
            if (await looksLikeDsh(url)) {
                return { url, auto, reachable: true, discovered: true, candidates };
            }
        }
    }
    return { url: candidates[0], auto, reachable: false, candidates };
}
