#!/usr/bin/env node
// qq-tools-server.mjs — 把「已开放的 QQ 动作」按**动作粒度**暴露成一个个独立 MCP 工具。
//
// 为什么不用官方的 @snowluma/mcp：它的执行侧只有 query_action / invoke_action 两个工具，
// 动作名是**参数**而不是工具名，于是 DSH 那边只能「整包开」或「整包关」，做不到
// 「允许 like_qzone、同时禁掉 set_group_ban」。这里把每个已开放的动作注册成一个独立工具：
//   · 粒度白名单天然成立（DSH 按工具名收口就够用）；
//   · **未开放的动作根本不会出现在工具清单里** —— 比「注册后再执行时拒绝」更干净，
//     模型也不会被诱导去调用它。
//
// 数据来源都是桥接自己维护的文件，本进程不依赖任何 npm 包：
//   · ../catalog/oneBotActions.json —— 动作目录（名字/分类/摘要/入参 JSON Schema）
//   · ../state/bridge-state.json    —— 已开放的动作名单 + 最近发现到的 OneBot 端点与令牌
//
// ⚠️ stdout 是 MCP 的传输通道，任何日志都必须走 stderr，否则会污染协议流。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.resolve(__dirname, '../catalog/oneBotActions.json');
const STATE_FILE = path.resolve(__dirname, '../state/bridge-state.json');
const SERVER_NAME = 'qq-tools';
const SERVER_VERSION = '1.0.0';
/** 单次动作调用的超时：上传类动作偏慢，给得比发消息宽。 */
const CALL_TIMEOUT_MS = 60_000;
/** 回给模型的文本上限：群成员列表之类的动作可能很大，截断避免撑爆上下文。 */
const MAX_TEXT_CHARS = 20_000;

function log(message) {
    process.stderr.write(`[qq-tools] ${message}\n`);
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** 动作名 → MCP 工具名；须与后端 src/const/actionCatalog.ts 的 toToolName 保持一致。 */
function toToolName(name) {
    return String(name ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * 每次调用都重读这两个文件。
 *
 * 这样前端改完开放名单、或后端重新发现端点/令牌之后，**不需要重启 DSH** 就能生效
 * （工具清单在每次开会话时重新拉取，端点在这之前取到最新的）。
 */
function loadRuntime() {
    const catalog = readJson(CATALOG_FILE);
    const state = readJson(STATE_FILE);
    const enabled = new Set(Array.isArray(state?.tools) ? state.tools.map(String) : []);
    const actions = (Array.isArray(catalog) ? catalog : []).filter((item) => item && enabled.has(String(item.name)));
    const endpoint = state?.onebot?.httpUrl
        ? { httpUrl: String(state.onebot.httpUrl).replace(/\/+$/, ''), token: String(state.onebot.token ?? '') }
        : null;
    return { actions, endpoint };
}

function buildTools(runtime) {
    return runtime.actions.map((action) => ({
        name: toToolName(action.name),
        description: `[${action.category}] ${action.summary || action.name}${action.readOnly ? '（只读）' : ''}`,
        inputSchema: action.inputSchema ?? { type: 'object', properties: {} },
    }));
}

function stringify(value) {
    let text;
    try {
        text = JSON.stringify(value ?? null, null, 2);
    } catch {
        text = String(value);
    }
    if (text === undefined) text = 'null';
    return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…（已截断，原始长度 ${text.length}）` : text;
}

/** 通过 OneBot HTTP API 调一次动作。 */
async function invoke(action, args, endpoint) {
    const res = await fetch(`${endpoint.httpUrl}/${action.name}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
        },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

    // 426 是「用错了端口」的典型特征：HTTP 与 WebSocket 在 SnowLuma 里是两套端口。
    if (res.status === 426) {
        throw new Error('上游要求升级协议：配置的 OneBot 地址可能指向了 WebSocket 端口，请改用 HTTP 端口（默认 3000）');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (!body || body.status !== 'ok' || body.retcode !== 0) {
        throw new Error(`${body?.status ?? '?'}/${body?.retcode ?? '?'} ${body?.wording ?? ''}`.trim());
    }
    return body.data;
}

async function callTool(toolName, args) {
    const runtime = loadRuntime();
    const action = runtime.actions.find((item) => toToolName(item.name) === toolName);

    if (!action) {
        return {
            content: [{ type: 'text', text: `动作「${toolName}」当前未在本机开放（可能刚被前端关掉），请不要重试。` }],
            isError: true,
        };
    }
    if (!runtime.endpoint) {
        return {
            content: [{ type: 'text', text: '桥接后端还没有可用的 OneBot 端点：请先在桥接页面连接 SnowLuma。' }],
            isError: true,
        };
    }

    try {
        const data = await invoke(action, args, runtime.endpoint);
        return { content: [{ type: 'text', text: stringify(data) }] };
    } catch (error) {
        return { content: [{ type: 'text', text: `${action.name} 执行失败：${error?.message ?? error}` }], isError: true };
    }
}

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function dispatch(message) {
    const method = String(message?.method ?? '');
    const params = message?.params ?? {};

    if (method === 'initialize') {
        // 回显客户端要求的协议版本：不同 MCP 客户端版本不一，回显最不容易被拒。
        return {
            protocolVersion: String(params.protocolVersion ?? '2024-11-05'),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: buildTools(loadRuntime()) };
    if (method === 'tools/call') return callTool(String(params.name ?? ''), params.arguments ?? {});
    // 本 server 不提供资源与提示词，但要把空清单答上，免得客户端握手时报错。
    if (method === 'resources/list') return { resources: [] };
    if (method === 'prompts/list') return { prompts: [] };

    throw fail(-32601, `不支持的方法：${method}`);
}

function reply(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function handleLine(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        log('收到无法解析的报文，已丢弃');
        return;
    }
    // 没有 id 的是通知（例如 notifications/initialized），按 JSON-RPC 规定不回包。
    if (message?.id === undefined || message?.id === null) return;

    try {
        reply({ jsonrpc: '2.0', id: message.id, result: await dispatch(message) });
    } catch (error) {
        reply({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: Number(error?.code) || -32603, message: String(error?.message ?? error) },
        });
    }
}

let buffer = '';
/** 还在处理的请求数：stdin 关闭后要等它们回完包再退出（管道式客户端会立刻关 stdin）。 */
let inflight = 0;
let stdinEnded = false;

function maybeExit() {
    if (stdinEnded && inflight === 0) process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
            inflight += 1;
            void handleLine(line).finally(() => {
                inflight -= 1;
                maybeExit();
            });
        }
        index = buffer.indexOf('\n');
    }
});
process.stdin.on('end', () => {
    stdinEnded = true;
    maybeExit();
});

if (!fs.existsSync(CATALOG_FILE)) log(`动作目录不存在：${CATALOG_FILE}`);
log('已启动，等待 MCP 客户端握手');
