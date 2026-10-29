import fs from 'node:fs';
import path from 'node:path';

const SRC = 'e:/test/ds-qq/qq-bridge-enhanced-v1.1.1/qq-bridge-enhanced-v1.1.1/node_modules/@snowluma/mcp/dist/generated/catalog.js';
const OUT_DIR = path.resolve(process.cwd(), 'catalog');
const OUT = path.join(OUT_DIR, 'oneBotActions.json');

const text = fs.readFileSync(SRC, 'utf8');
const start = text.indexOf('[');
let depth = 0;
let inString = false;
let escaped = false;
let end = -1;
for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
        depth--;
        if (depth === 0) {
            end = i;
            break;
        }
    }
}

const actions = JSON.parse(text.slice(start, end + 1));
const slim = actions.map((a) => ({
    name: a.name,
    category: a.category,
    summary: a.summary ?? '',
    readOnly: a.readOnly === true,
    inputSchema: a.inputSchema,
}));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, '[\n' + slim.map((item) => JSON.stringify(item)).join(',\n') + '\n]\n', 'utf8');

const SAFE = [
    'send_private_msg', 'send_group_msg', 'send_msg',
    'forward_friend_single_msg', 'forward_group_single_msg',
    'mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read',
    'send_poke', 'friend_poke', 'group_poke',
    'set_msg_emoji_like', 'set_group_reaction',
    'get_emoji_likes', 'get_msg_emoji_likes',
    'add_custom_face', 'modify_custom_face', 'delete_custom_face', 'move_custom_face_to_front',
    'fetch_custom_face', 'fetch_custom_face_detail', 'send_custom_face',
    'send_like', 'get_profile_like',
    'like_qzone', 'unlike_qzone', 'comment_qzone', 'get_qzone_feeds', 'get_qzone_msg_list',
    'get_login_info', 'get_status', 'get_version_info', 'get_online_clients',
    'get_friend_list', 'get_stranger_info',
    'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info',
    'get_group_honor_info', 'get_group_shut_list', 'get_group_admin_settings',
    'get_msg', 'get_group_msg_history', 'get_friend_msg_history', 'get_forward_msg', 'get_essence_msg_list',
    'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url', 'get_private_file_url',
    'get_group_album_list', 'get_group_album_media_list', 'get_qun_album_list',
    'fetch_sys_faces', 'search_sys_faces', 'fetch_face_entity', 'fetch_super_face_id',
    'get_image', 'get_file',
];

const known = new Set(slim.map((a) => a.name));
const missing = SAFE.filter((n) => !known.has(n));
console.log('actions:', slim.length, '| safe:', SAFE.length, '| missing:', missing);
console.log('bytes:', fs.statSync(OUT).size);
