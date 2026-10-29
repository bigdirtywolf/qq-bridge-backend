// OneBot v11 动作目录：DSH 能以「工具」形式调用的 QQ 动作清单。
//
// 数据来自 @snowluma/mcp 的生成目录（dist/generated/catalog.js，共 195 个规范动作），
// 落到 catalog/oneBotActions.json，只保留桥接真正要用的字段：
// 动作名 / 分类 / 中文摘要 / 是否只读 / 入参 JSON Schema。
//
// 为什么内置而不是运行时去读 @snowluma/mcp：MCP server 是被 DSH 单独拉起的进程，
// 后端不该为了它多背一个运行时依赖；而且动作目录只在 QQ 端换版本时才变，属于静态数据。
//
// 目录文件放在项目根（不是 src/ 里）：nest build 只编译 src/，放根目录下
// dist/const/xxx.js 与 src/const/xxx.ts 相对同一份文件的层级一致，dev 与 build 都能读。
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/log4js';

/** 一个 OneBot 动作的元信息。 */
export interface OneBotActionMeta {
    name: string
    category: string
    summary: string
    readOnly: boolean
    /** 传给模型的入参 JSON Schema，原样取自动作目录。 */
    inputSchema: any
}

/** 目录文件位置：<项目根>/catalog/oneBotActions.json。 */
export const CATALOG_FILE = path.resolve(__dirname, '../../catalog/oneBotActions.json');

/**
 * 默认开放的「安全子集」。
 *
 * 逐条写死而不是用规则推导，是为了能一眼审阅：规则推导（例如「所有只读动作」）
 * 会把 get_cookies / get_csrf_token 这类**只读但等于交出账号**的动作一并放进来。
 *
 * 收录原则：日常聊天用得上的收发与查询 + 点赞/评论/表情这类无破坏性的写动作。
 * 刻意不收：
 *   1. 凭证类（get_cookies / get_csrf_token / get_clientkey / get_credentials）；
 *   2. 破坏性写动作（禁言、踢人、改群设置、删好友、退群、发/删说说、bot_exit 等）；
 *   3. 占位或未实现的动作，以及闪传 / rkey / packet 这类与聊天无关的扩展动作。
 * 这些动作仍然可以在前端勾选，只是默认不开。
 */
export const SAFE_ACTION_NAMES: string[] = [
    // 消息收发
    'send_private_msg', 'send_group_msg', 'send_msg',
    'forward_friend_single_msg', 'forward_group_single_msg',
    'mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read',
    // 拍一拍
    'send_poke', 'friend_poke', 'group_poke',
    // 消息表情回应
    'set_msg_emoji_like', 'set_group_reaction', 'get_emoji_likes', 'get_msg_emoji_likes',
    // 收藏表情
    'add_custom_face', 'modify_custom_face', 'delete_custom_face', 'move_custom_face_to_front',
    'fetch_custom_face', 'fetch_custom_face_detail', 'send_custom_face',
    // 资料点赞
    'send_like', 'get_profile_like',
    // QQ 空间（只开放点赞/评论与读取，发说说/删说说默认不开）
    'like_qzone', 'unlike_qzone', 'comment_qzone', 'get_qzone_feeds', 'get_qzone_msg_list',
    // 账号与状态
    'get_login_info', 'get_status', 'get_version_info', 'get_online_clients',
    // 好友
    'get_friend_list', 'get_stranger_info',
    // 群（只读）
    'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info',
    'get_group_honor_info', 'get_group_shut_list', 'get_group_admin_settings',
    // 消息查询
    'get_msg', 'get_group_msg_history', 'get_friend_msg_history', 'get_forward_msg', 'get_essence_msg_list',
    // 群文件（只读）
    'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url', 'get_private_file_url',
    // 群相册（只读）
    'get_group_album_list', 'get_group_album_media_list', 'get_qun_album_list',
    // QQ 系统表情（只读）
    'fetch_sys_faces', 'search_sys_faces', 'fetch_face_entity', 'fetch_super_face_id',
    // 媒体（只读）
    'get_image', 'get_file',
];

/** 读一次目录文件；读不到就返回空数组，桥接其余功能不受影响。 */
function loadCatalog(): OneBotActionMeta[] {
    try {
        const list = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
        if (!Array.isArray(list)) return [];
        return list
            .filter((item: any) => item && typeof item.name === 'string')
            .map((item: any) => ({
                name: String(item.name),
                category: String(item.category ?? '其它'),
                summary: String(item.summary ?? ''),
                readOnly: item.readOnly === true,
                inputSchema: item.inputSchema ?? { type: 'object', properties: {} },
            }));
    } catch(error) {
        Logger.warn(`[Catalog] 读取动作目录失败（${CATALOG_FILE}）：`, error?.message ?? error);
        return [];
    }
}

export const ONE_BOT_ACTIONS: OneBotActionMeta[] = loadCatalog();

const ACTION_INDEX: Map<string, OneBotActionMeta> = new Map(ONE_BOT_ACTIONS.map((item) => [item.name, item]));

/** 默认开放的安全子集，已剔除目录里不存在的名字（防止名单写错后静默失效）。 */
function resolveSafeActions(): string[] {
    const missing = SAFE_ACTION_NAMES.filter((name) => !ACTION_INDEX.has(name));
    if (missing.length) Logger.warn(`[Catalog] 安全子集里有 ${missing.length} 个动作不在目录中，已忽略：${missing.join(', ')}`);
    return SAFE_ACTION_NAMES.filter((name) => ACTION_INDEX.has(name));
}

/** 默认开放的动作名（每次调用返回副本，调用方改不动内部状态）。 */
export function defaultEnabledActions(): string[] {
    return resolveSafeActions();
}

/** 按分类列动作；不传分类时返回全部（前端按分类分组展示）。 */
export function listActions(category?: string): OneBotActionMeta[] {
    const key = String(category ?? '').trim();
    return key ? ONE_BOT_ACTIONS.filter((item) => item.category === key) : [...ONE_BOT_ACTIONS];
}

/** 查一个动作的元信息。 */
export function getActionMeta(name: string): OneBotActionMeta | null {
    return ACTION_INDEX.get(String(name ?? '').trim()) ?? null;
}

/** 目录里的分类及动作数，按目录出现顺序返回。 */
export function listCategories(): Array<{ name: string; count: number }> {
    const order: string[] = [];
    const counter = new Map<string, number>();
    for (const item of ONE_BOT_ACTIONS) {
        if (!counter.has(item.category)) order.push(item.category);
        counter.set(item.category, (counter.get(item.category) ?? 0) + 1);
    }
    return order.map((name) => ({ name, count: counter.get(name) ?? 0 }));
}

/** 收敛一份启用名单：只留目录里真实存在的动作，去重并保持目录顺序。 */
export function normalizeEnabledActions(value: any): string[] | null {
    if (!Array.isArray(value)) return null;
    const want = new Set<string>();
    for (const item of value) {
        const name = String(item ?? '').trim();
        if (name && ACTION_INDEX.has(name)) want.add(name);
    }
    // 按目录顺序输出：写入配置后 diff 稳定，不随前端勾选顺序抖动。
    return ONE_BOT_ACTIONS.filter((item) => want.has(item.name)).map((item) => item.name);
}

/**
 * 动作名 → MCP 工具名。
 *
 * MCP 规定工具名只能包含字母、数字、下划线与连字符，而目录里存在 `.get_word_slices`
 * 这种带点号的名字；不合法的字符统一换成下划线（同时把连字符也换掉，避免与连字符
 * 语义混淆，保证映射是单射）。
 */
export function toToolName(actionName: string): string {
    return String(actionName ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_');
}

/** 目录文件里是否存在这个动作。 */
export function isKnownAction(name: string): boolean {
    return ACTION_INDEX.has(String(name ?? '').trim());
}
