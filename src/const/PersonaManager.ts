// 人格（角色卡）管理：人格正文以 Markdown 存在 roles/<角色名>.md，当前启用哪个人格存在运行态里。
//
// 为什么人格要落成 .md 文件而不是塞进 JSON：人格卡是「人设」，需要反复手改、便于备份与分享，
// 一个角色一个文件最直观（前端也直接读写这份 Markdown 正文）。
//
// 注入方式与参考实现一致：人格卡作为**每条消息**的前缀随用户消息一起发给 DSH，
// 所以有 role.maxInjectChars 这道成本护栏（默认 6000 字符）。
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/log4js';
import { StateStore, normalizeMaxInjectChars } from '../utils/stateStore';

/** 人格卡目录：默认项目根下的 roles/，可用 ROLES_DIR 覆盖。 */
const ROLES_DIR = process.env.ROLES_DIR
    ? path.resolve(process.env.ROLES_DIR)
    : path.resolve(__dirname, '../../roles');

/** 单个角色名的长度上限。 */
const MAX_NAME_CHARS = 40;
/** 单份人格卡的长度上限（防止误粘贴超长文本把每条消息都撑爆）。 */
const MAX_ROLE_CHARS = 40000;

/** Windows 保留名，用作文件名会建不出来。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|readme)$/i;

/** 新建人格时的模板，与「推荐结构」一致。 */
const ROLE_TEMPLATE = `# 角色卡：<角色名>

## 一、你是谁
- 身份、自我认知、别人怎么称呼你、你的雷点。

## 二、说话风格
- 句子长短、口头禅、标点习惯、用不用 emoji/括号。
- 明确写「不要什么」通常比写「要什么」更有效（例如：不要总结、不要升华、不要客服腔）。

## 三、性格与反应
- 被夸/被怼/被无视时分别怎么反应。

## 四、梗与背景（可选）
- 你的来历、和群里人的关系、常用梗。

## 五、回复示例（示范语气与长度）
- 几条「群友说 → 你回」的例子。
`;

/** 一个人格的概要（列表用）。 */
export interface PersonaSummary {
    name: string
    chars: number
    updatedAt: number
    current: boolean
}

/** 校验角色名；不合法时返回错误原因。 */
function checkName(name: string): string | null {
    const value = String(name ?? '').trim();
    if (!value) return '角色名不能为空';
    if (value.length > MAX_NAME_CHARS) return `角色名不能超过 ${MAX_NAME_CHARS} 个字符`;
    if (value === '.' || value === '..') return '角色名不合法';
    if (/[\\/:*?"<>|]/.test(value)) return '角色名不能包含 \\ / : * ? " < > | 等字符';
    if (RESERVED_NAMES.test(value)) return `角色名不能使用保留名 ${value}`;
    return null;
}

export class PersonaManager {
    private readonly store: StateStore

    constructor(store: StateStore) {
        this.store = store;
    }

    /** 人格卡所在目录（供接口展示）。 */
    getDir(): string {
        return ROLES_DIR;
    }

    /** 磁盘上的人格卡列表，按角色名排序。 */
    list(): PersonaSummary[] {
        const current = this.store.getPersona().current;
        let files: string[] = [];
        try {
            files = fs.readdirSync(ROLES_DIR).filter((name) => name.toLowerCase().endsWith('.md'));
        } catch {
            return [];
        }

        return files
            .map((file) => {
                const name = file.slice(0, -3);
                const full = path.join(ROLES_DIR, file);
                let chars = 0;
                let updatedAt = 0;
                try {
                    const stat = fs.statSync(full);
                    chars = fs.readFileSync(full, 'utf8').length;
                    updatedAt = stat.mtimeMs;
                } catch {
                    // 单个文件读不到就按 0 字符展示，不影响列表。
                }
                return { name, chars, updatedAt, current: name === current };
            })
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    }

    /** 读取一份人格卡正文；不存在返回 null。 */
    read(name: string): string | null {
        const error = checkName(name);
        if (error) return null;
        try {
            return fs.readFileSync(path.join(ROLES_DIR, `${String(name).trim()}.md`), 'utf8');
        } catch {
            return null;
        }
    }

    /** 新建人格卡；同名已存在时抛错。 */
    create(name: string, content?: string): string {
        const error = checkName(name);
        if (error) throw new Error(error);

        const value = String(name).trim();
        const file = path.join(ROLES_DIR, `${value}.md`);
        if (fs.existsSync(file)) throw new Error(`人格「${value}」已存在`);

        const text = String(content ?? '').trim() ? String(content) : ROLE_TEMPLATE.replace('<角色名>', value);
        fs.mkdirSync(ROLES_DIR, { recursive: true });
        fs.writeFileSync(file, text, 'utf8');
        Logger.info(`[Persona] 已新建人格：${value}`);
        return text;
    }

    /** 覆盖保存人格卡正文；不存在时按新建处理（前端「保存」在只有名字时也能用）。 */
    save(name: string, content: string): void {
        const error = checkName(name);
        if (error) throw new Error(error);

        const text = String(content ?? '');
        if (text.length > MAX_ROLE_CHARS) throw new Error(`人格卡不能超过 ${MAX_ROLE_CHARS} 个字符`);

        const value = String(name).trim();
        fs.mkdirSync(ROLES_DIR, { recursive: true });
        fs.writeFileSync(path.join(ROLES_DIR, `${value}.md`), text, 'utf8');
        Logger.info(`[Persona] 已保存人格：${value}（${text.length} 字符）`);
    }

    /** 删除人格卡；删掉的正好是当前启用的人格时，一并清空启用状态。 */
    remove(name: string): void {
        const error = checkName(name);
        if (error) throw new Error(error);

        const value = String(name).trim();
        const file = path.join(ROLES_DIR, `${value}.md`);
        if (!fs.existsSync(file)) throw new Error(`人格「${value}」不存在`);
        fs.rmSync(file);
        if (this.store.getPersona().current === value) this.store.setPersona({ current: null });
        Logger.info(`[Persona] 已删除人格：${value}`);
    }

    /** 启用某个人格；传空字符串表示清除（只按仿真提示词行动）。 */
    setCurrent(name: string | null): void {
        const value = name ? String(name).trim() : '';
        if (!value) {
            this.store.setPersona({ current: null });
            return;
        }
        if (this.read(value) === null) throw new Error(`人格「${value}」不存在`);

        // 首次启用时把「当前人格」也标记到位：前端列表依赖它。
        this.store.setPersona({ current: value });
        Logger.info(`[Persona] 已启用人格：${value}`);
    }

    /** 当前启用的人格与注入上限。 */
    getCurrent(): { name: string | null; maxInjectChars: number; chars: number } {
        const state = this.store.getPersona();
        const text = state.current ? this.read(state.current) : null;
        return { name: text === null ? null : state.current, maxInjectChars: state.maxInjectChars, chars: text?.length ?? 0 };
    }

    /** 设置注入上限；返回生效后的取值。 */
    setMaxInjectChars(value: any): number {
        return this.store.setPersona({ maxInjectChars: normalizeMaxInjectChars(value) }).maxInjectChars;
    }

    /**
     * 生成要注入的人格前缀。
     *
     * 截断只发生在最后一步：超出上限时按字符数硬切（写进日志，便于排查「人设好像没生效」）。
     */
    buildPrefix(): string {
        const state = this.store.getPersona();
        if (!state.current) return '';

        const text = this.read(state.current);
        if (text === null) {
            Logger.warn(`[Persona] 当前人格「${state.current}」已不存在，本次不注入人格`);
            return '';
        }

        const body = text.trim();
        if (body.length <= state.maxInjectChars) return body;

        Logger.warn(`[Persona] 人格「${state.current}」超出注入上限（${body.length} > ${state.maxInjectChars}），已截断`);
        return `${body.slice(0, state.maxInjectChars)}\n（人格卡超出注入上限，以上为截断后的内容）`;
    }
}
