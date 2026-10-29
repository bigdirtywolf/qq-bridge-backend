// DSH 侧注册：把 mcp/qq-tools-server.mjs 挂进 DSH profile 的 cordis.patch.yml。
//
// 条目格式对照参考实现的 scripts/setup-dsh.mjs（那是权威写法）：
//   - insert:
//       - id: <插件 id>
//         name: '@deepseek-ai/dsh-mcp-client'
//         config:
//           serverName: ...
//           transport: stdio
//           command: ...
//           args: [...]
//
// 与参考实现的三点差异：
//   1. 只维护自己那段带 BEGIN/END 标记的区块，profile 里的其它内容（含参考实现的
//      「qq-bridge MCP」区块）原样保留，两边互不覆盖；
//   2. desktop 与 web 两个 profile 同时存在时**两个都写**：后端无法判断用户跑的是哪一个，
//      而「配置看起来成功了、DSH 却拿不到工具」比多写一份更难排查；
//   3. 改文件前留一份 .bak-qq-tools 快照 —— cordis.patch.yml 写坏会直接让 DSH 起不来。
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './log4js';
import { dshHomeDir } from './dshEndpoint';

/** 本插件在 profile 里的 id（DSH 用它区分同一名字的多个插件实例）。 */
const MANAGED_ID = 'mcp-qq-tools';
/** MCP server 名：DSH 侧工具名会变成 mcp__qq-tools__<动作名>。 */
const SERVER_NAME = 'qq-tools';
/** 托管区块的标记；与参考实现的「qq-bridge MCP」标记刻意不同。 */
const BEGIN_MARK = '# === qq-tools MCP BEGIN ===';
const END_MARK = '# === qq-tools MCP END ===';
/** DSH 会优先用这两个 profile 名；不存在时才退化成「profiles 下的所有目录」。 */
const PROFILE_CANDIDATES = ['desktop', 'web'];
/** 单次动作调用的宽限期：上传类动作偏慢，比默认值给得宽。 */
const TOOL_CALL_TIMEOUT_MS = 725000;

/** MCP server 脚本的绝对路径（随仓库位置变化，写进配置时是绝对路径）。 */
export function resolveMcpScript(): string {
    return path.resolve(__dirname, '../../mcp/qq-tools-server.mjs');
}

/** 一次注册/注销的结果，同时用作接口返回。 */
export interface DshMcpSyncResult {
    ok: boolean
    /** 当前是否已挂载（enabled=false 时表示已移除 / 本来就没有）。 */
    registered: boolean
    /** 写入过的 profile 目录。 */
    profiles: string[]
    /** 实际改动的配置文件。 */
    configPaths: string[]
    /** MCP server 脚本路径。 */
    script: string
    /** ok=false 时的原因（DSH 没装、脚本不存在等），前端直接展示。 */
    reason: string | null
}

/** YAML 单引号字符串：内部单引号按 YAML 规则双写转义。 */
function yamlSingleQuote(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** 生成要写入的托管区块（末尾带换行）。 */
function managedBlock(): string {
    const lines = [
        BEGIN_MARK,
        '# 由 qq-bridge 后端维护；这段区块会被整体替换，请勿手工编辑内部条目。',
        '- insert:',
        `    - id: ${MANAGED_ID}`,
        `      name: '@deepseek-ai/dsh-mcp-client'`,
        '      config:',
        `        serverName: ${SERVER_NAME}`,
        '        transport: stdio',
        `        command: ${yamlSingleQuote(process.execPath)}`,
        '        args:',
        `          - ${yamlSingleQuote(resolveMcpScript())}`,
        `        toolCallTimeoutMs: ${TOOL_CALL_TIMEOUT_MS}`,
        END_MARK,
    ];
    return `${lines.join('\n')}\n`;
}

/** 摘掉已有的托管区块；没有标记就原样返回。 */
function stripManaged(content: string): string {
    const start = content.indexOf(BEGIN_MARK);
    if (start < 0) return content;

    const end = content.indexOf(END_MARK, start);
    if (end < 0) return content.slice(0, start);

    // 连标记后面那一个换行一起去掉，避免反复写成空行。
    const tail = content.slice(end + END_MARK.length).replace(/^[^\S\n]*\n/, '');
    return content.slice(0, start) + tail;
}

/** 把托管区块写进一个 patch 文件；返回是否真的改了文件。 */
function writeManaged(file: string, block: string | null): boolean {
    let content = '';
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        // 文件不存在：cordis.patch.yml 的根节点是一个 YAML 序列，空序列写 `[]`。
        content = '[]\n';
    }

    // 关掉托管且本来就没托管过：一个字节都不要动。
    if (!block && content.indexOf(BEGIN_MARK) < 0) return false;

    const next = `${stripManaged(content).replace(/\s+$/, '')}\n${block ?? ''}`;
    if (next === content) return false;

    try {
        fs.copyFileSync(file, `${file}.bak-qq-tools`);
    } catch {
        // 首次创建时没有原文件可备份，忽略。
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, 'utf8');
    return true;
}

/** 找出要写入的 profile 目录。 */
function profileDirs(dshHome: string): { dirs: string[]; reason: string | null } {
    const base = path.join(dshHome, 'profiles');
    let names: string[] = [];
    try {
        names = fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return { dirs: [], reason: `未找到 DSH 的 profiles 目录：${base}（DSH 可能没装在本机，可用 DSH_HOME 指定）` };
    }

    const preferred = PROFILE_CANDIDATES.filter((name) => names.includes(name));
    if (preferred.length) return { dirs: preferred.map((name) => path.join(base, name)), reason: null };

    // 连 desktop / web 都没有：把 profiles 下的目录全写上，宁可多写也不要静默不生效。
    const dirs = names.map((name) => path.join(base, name));
    return dirs.length ? { dirs, reason: null } : { dirs: [], reason: `DSH 的 profiles 目录是空的：${base}` };
}

/** 只读地看当前注册状态，不写文件。 */
export function readDshMcpStatus(): DshMcpSyncResult {
    const script = resolveMcpScript();
    const dshHome = dshHomeDir();
    const base: DshMcpSyncResult = { ok: false, registered: false, profiles: [], configPaths: [], script, reason: null };

    if (!fs.existsSync(dshHome)) return { ...base, reason: `未找到 DSH 主目录：${dshHome}（可用 DSH_HOME 指定）` };

    const { dirs, reason } = profileDirs(dshHome);
    if (!dirs.length) return { ...base, reason };

    const configPaths = dirs.map((dir) => path.join(dir, 'cordis.patch.yml'));
    let registered = false;
    for (const file of configPaths) {
        try {
            if (fs.readFileSync(file, 'utf8').includes(BEGIN_MARK)) registered = true;
        } catch {
            // 文件不存在就是没注册。
        }
    }
    return { ok: true, registered, profiles: dirs, configPaths, script, reason: null };
}

/**
 * 按启用状态挂载或移除 MCP server。
 *
 * @param enabled - true=写入托管区块，false=摘掉托管区块。都可重复执行（幂等）。
 */
export function syncDshMcpServer(enabled: boolean): DshMcpSyncResult {
    const script = resolveMcpScript();
    const dshHome = dshHomeDir();
    const base: DshMcpSyncResult = { ok: false, registered: false, profiles: [], configPaths: [], script, reason: null };

    if (!fs.existsSync(script)) return { ...base, reason: `MCP server 脚本不存在：${script}` };
    if (!fs.existsSync(dshHome)) return { ...base, reason: `未找到 DSH 主目录：${dshHome}（可用 DSH_HOME 指定）` };

    const { dirs, reason } = profileDirs(dshHome);
    if (!dirs.length) return { ...base, reason };

    const configPaths = dirs.map((dir) => path.join(dir, 'cordis.patch.yml'));
    try {
        const block = enabled ? managedBlock() : null;
        for (const file of configPaths) writeManaged(file, block);
    } catch (error) {
        Logger.error('[DshMcp] 写入 cordis.patch.yml 失败：', (error as Error)?.message ?? error);
        return { ...base, profiles: dirs, configPaths, reason: `写入失败：${(error as Error)?.message ?? error}` };
    }

    Logger.info(`[DshMcp] 已${enabled ? '挂载' : '移除'} ${SERVER_NAME}（${configPaths.join('、')}）`);
    return { ok: true, registered: enabled, profiles: dirs, configPaths, script, reason: null };
}
