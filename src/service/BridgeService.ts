// 桥接服务：把「QQ 收到消息 → 注入人格 → 交给 DSH → 回复 QQ」串成一条链。
//
// 三个要点：
//   1. **串行队列**：DSH 的回复要按会话匹配回合，并发投递会让答复错位（A 的回复发到 B），
//      所以所有来访消息统一排进一条队列，一条处理完再处理下一条。
//   2. **允许名单**：名单为空且没开「空名单放行全部」时，谁都不要回。默认保守，
//      免得机器人一接上就对所有人开口。
//   3. **会话映射要落盘**：DSH 的 sessionId 建一次就长期有效，重启后端不该重新建会话。
//
// 人格正文不在这里管：PersonaManager 负责读写 roles/<角色名>.md，这里只用它的 buildPrefix()。
//
// 另一条链是「DSH 主动操作 QQ」：开放的 QQ 动作由前端逐条勾选，MCP server 按勾选结果
// 注册成独立工具（详见 mcp/qq-tools-server.mjs），这里只负责存名单 + 把 MCP 条目同步到 DSH。
import { defaultEnabledActions, listActions, listCategories, normalizeEnabledActions } from 'src/const/actionCatalog';
import { DshManager } from 'src/const/DshManager';
import { PersonaManager } from 'src/const/PersonaManager';
import { ResultData } from 'src/const/Result';
import { SnowLumaManager } from 'src/const/SnowLumaManager';
import { BridgeStatusDTO, ConnectDTO } from 'src/dto/ConnectionDTO';
import { BridgeConfigDTO, ChatDTO, PersonaCreateDTO, PersonaNameDTO, PersonaSaveDTO, QqMessage, ToolsConfigDTO } from 'src/dto/BridgeDTO';
import { readDshMcpStatus, syncDshMcpServer } from 'src/utils/dshMcp';
import { Logger } from 'src/utils/log4js';
import { StateStore } from 'src/utils/stateStore';

/** 一次会话的 key 约定：private:<QQ号> / group:<群号>。 */
function sessionKey(kind: 'private' | 'group', id: string): string {
    return `${kind}:${id}`;
}

/** 桥接服务：持有 SnowLuma 与 DSH 两个连接管理器，并负责消息编排、配置与人格。 */
export class BridgeService {
    private readonly state: StateStore
    private readonly persona: PersonaManager
    private snowLuma: SnowLumaManager
    private dsh: DshManager
    /** 串行队列的尾指针：新消息挂在它后面，保证一次只处理一条。 */
    private queue: Promise<void> = Promise.resolve()

    constructor() {
        this.state = new StateStore()
        this.persona = new PersonaManager(this.state)
        // 先建好「未连接」的实例：状态接口在任何时刻都能返回完整结构，前端不用判空。
        this.snowLuma = new SnowLumaManager()
        this.dsh = new DshManager()
        this.bindSnowLuma()

        // 「已开放动作」第一次启动时落成安全子集：MCP server 是独立进程，它读不到
        // 这里的默认值，只能读运行态文件，所以必须把解析结果写下去。
        // 这一步只写名单，不碰 DSH 配置 —— 挂载 MCP 要等用户在前端点一次保存才算同意。
        if (this.state.getEnabledActions() === null) {
            this.state.setEnabledActions(defaultEnabledActions())
            Logger.info(`[Bridge] 已写入默认开放的 QQ 动作（${defaultEnabledActions().length} 个）`)
        }
    }

    /** 按传入参数连接 SnowLuma 与 DSH；重复调用会先断开旧连接。 */
    async connect(connectDTO: ConnectDTO) {
        try {
            this.close()

            this.snowLuma = new SnowLumaManager(connectDTO?.snowLuma ?? {})
            // 会话映射从运行态恢复：DSH 侧的会话还在，不用重建。
            this.dsh = new DshManager(connectDTO?.dsh ?? {}, this.state.getSessions())
            this.bindSnowLuma()
            this.snowLuma.start()
            this.dsh.start()

            return ResultData.success(this.snapshot())
        } catch(error) {
            Logger.error('[Bridge] 连接失败：', error?.message ?? error)
            return ResultData.fail(error.message)
        }
    }

    /** 断开两个连接并释放定时器。 */
    async disconnect() {
        this.close()
        return ResultData.success(this.snapshot())
    }

    /** 当前连接状态快照。 */
    async status() {
        return ResultData.success(this.snapshot())
    }

    /** 手动发一条消息；viaDsh 为 true 时先让 DSH 生成回复再发。 */
    async sendMessage(chatDTO: ChatDTO) {
        const kind = chatDTO?.kind === 'group' ? 'group' : 'private'
        const id = String(chatDTO?.id ?? '').trim()
        const text = String(chatDTO?.text ?? '').trim()
        if (!id) return ResultData.fail(400, '缺少会话 id（私聊传 QQ 号，群聊传群号）')
        if (!text) return ResultData.fail(400, '消息内容不能为空')

        let out = text
        const viaDsh = chatDTO?.viaDsh !== false
        if (viaDsh) {
            try {
                const reply = await this.dsh.chat(sessionKey(kind, id), this.buildPrompt(text))
                this.persistSessions()
                out = reply.text.trim()
            } catch(error) {
                return ResultData.fail(400, `DSH 生成回复失败：${error?.message ?? error}`)
            }
            // DSH 判定「这次没什么好说的」：不硬凑一条空消息发出去。
            if (!out) return ResultData.success({ sent: false, text: '', viaDsh }, 'DSH 本次没有回复，已跳过发送')
        }

        try {
            await this.snowLuma.sendMessage(kind, id, out)
        } catch(error) {
            return ResultData.fail(400, `发送失败：${error?.message ?? error}`)
        }

        this.state.pushMessage({
            at: Date.now(),
            direction: 'out',
            kind,
            id,
            name: id,
            text: out,
            viaDsh,
        })
        return ResultData.success({ sent: true, text: out, viaDsh }, viaDsh ? '已由 DSH 生成并发送' : '已发送')
    }

    /** 最近的消息记录（默认最近 50 条，按时间正序）。 */
    async messages(limit?: string) {
        return ResultData.success(this.state.getMessages(Number(limit) || 50))
    }

    /** 清空消息记录。 */
    async clearMessages() {
        this.state.clearMessages()
        return ResultData.success([])
    }

    /** 当前配置：允许名单 + 当前人格 + 人格卡目录。 */
    async config() {
        return ResultData.success({
            allow: this.state.getAllow(),
            persona: this.persona.getCurrent(),
            rolesDir: this.persona.getDir(),
        })
    }

    /** 更新配置：允许名单与人格的启用状态、注入上限。 */
    async setConfig(bridgeConfigDTO: BridgeConfigDTO) {
        try {
            if (bridgeConfigDTO?.allow) this.state.setAllow(bridgeConfigDTO.allow)
            if (bridgeConfigDTO?.persona) {
                const { current, maxInjectChars } = bridgeConfigDTO.persona
                if (current !== undefined) this.persona.setCurrent(current)
                if (maxInjectChars !== undefined) this.persona.setMaxInjectChars(maxInjectChars)
            }
            return this.config()
        } catch(error) {
            return ResultData.fail(400, error?.message ?? String(error))
        }
    }

    /** 人格卡列表（含当前启用项）。 */
    async personaList() {
        return ResultData.success({
            dir: this.persona.getDir(),
            list: this.persona.list(),
            current: this.persona.getCurrent(),
        })
    }

    /** 读取一份人格卡正文。 */
    async personaDetail(name: string) {
        const content = this.persona.read(String(name ?? ''))
        if (content === null) return ResultData.fail(404, `人格「${name}」不存在`)
        return ResultData.success({ name: String(name).trim(), content })
    }

    /** 新建人格卡；content 留空时写入模板。 */
    async personaCreate(personaCreateDTO: PersonaCreateDTO) {
        try {
            const content = this.persona.create(personaCreateDTO?.name, personaCreateDTO?.content)
            return ResultData.success({ name: String(personaCreateDTO?.name ?? '').trim(), content }, '人格已新建')
        } catch(error) {
            return ResultData.fail(400, error?.message ?? String(error))
        }
    }

    /** 保存人格卡正文（不存在则按新建处理）。 */
    async personaSave(personaSaveDTO: PersonaSaveDTO) {
        try {
            this.persona.save(personaSaveDTO?.name, personaSaveDTO?.content ?? '')
            return ResultData.success({ name: String(personaSaveDTO?.name ?? '').trim() }, '人格已保存')
        } catch(error) {
            return ResultData.fail(400, error?.message ?? String(error))
        }
    }

    /** 删除人格卡。 */
    async personaDelete(personaNameDTO: PersonaNameDTO) {
        try {
            this.persona.remove(personaNameDTO?.name)
            return ResultData.success(null, '人格已删除')
        } catch(error) {
            return ResultData.fail(400, error?.message ?? String(error))
        }
    }

    /**
     * 「DSH → QQ」工具配置：完整动作目录 + 当前开放名单 + DSH 侧挂载状态。
     *
     * 目录只回传前端要用的四个字段：真正的入参 Schema 只由 MCP server 读，
     * 全量塞进响应会让这个接口白胖一圈。
     */
    async tools() {
        const dsh = readDshMcpStatus()
        return ResultData.success({
            categories: listCategories(),
            actions: listActions().map(({ name, category, summary, readOnly }) => ({ name, category, summary, readOnly })),
            enabled: this.state.getEnabledActions() ?? defaultEnabledActions(),
            defaultEnabled: defaultEnabledActions(),
            endpointReady: this.state.getOneBotEndpoint() !== null,
            dsh,
        })
    }

    /** 保存开放名单，并把 MCP 条目同步到 DSH（一个都不开放时摘掉条目）。 */
    async setTools(toolsConfigDTO: ToolsConfigDTO) {
        const enabled = normalizeEnabledActions(toolsConfigDTO?.enabled)
        if (enabled === null) return ResultData.fail(400, 'enabled 需要是动作名数组')

        this.state.setEnabledActions(enabled)

        const dropped = (toolsConfigDTO?.enabled?.length ?? 0) - enabled.length
        const dsh = syncDshMcpServer(enabled.length > 0)
        if (!dsh.ok) {
            // 名单已经存下来了，只是没同步到 DSH（例如本机没装 DSH）：如实告知，不要假装成功。
            Logger.warn('[Bridge] QQ 动作已保存，但同步到 DSH 失败：', dsh.reason)
            return ResultData.success({ enabled, dropped, dsh }, `已保存，但同步到 DSH 失败：${dsh.reason}`)
        }
        const tip = enabled.length ? `已开放 ${enabled.length} 个动作，重启 DSH 后生效` : '已关闭全部动作，并摘掉 DSH 侧条目'
        return ResultData.success({ enabled, dropped, dsh }, dropped > 0 ? `${tip}（忽略 ${dropped} 个未知动作名）` : tip)
    }

    private close() {
        this.snowLuma?.stop()
        this.dsh?.stop()
    }

    private snapshot(): BridgeStatusDTO {
        return {
            snowLuma: this.snowLuma.getState(),
            dsh: this.dsh.getState(),
        }
    }

    /** 把 QQ 消息处理器挂到当前 SnowLuma 实例上（每次连接后都要重挂）。 */
    private bindSnowLuma(): void {
        this.snowLuma.onMessage((message) => void this.handleIncoming(message))
        // 端点/令牌一变就落盘：独立的 MCP server 进程只能从这里读到它。
        this.snowLuma.onEndpoint((endpoint) => this.state.setOneBotEndpoint(endpoint))
    }

    /**
     * 收到一条 QQ 消息：先过筛（自己的消息 / 名单 / 群里没 @），再排队回复。
     *
     * 入站消息先记一条，前端能立刻看到；回复是否成功在 {@link reply} 里另行记录。
     */
    private async handleIncoming(message: QqMessage): Promise<void> {
        const self = this.snowLuma.getSelf()
        if (self && message.userId === self.userId) return
        if (!this.isAllowed(message)) return
        // 群聊只在被 @ 时才开口，否则机器人在群里会变得很吵。
        if (message.kind === 'group' && !message.atMe) return

        const text = String(message.text ?? '').trim()
        if (!text) return

        this.state.pushMessage({
            at: message.at,
            direction: 'in',
            kind: message.kind,
            id: message.id,
            name: message.kind === 'group' ? `${message.id}/${message.nickname}` : message.nickname,
            text,
            viaDsh: false,
        })

        this.queue = this.queue
            .then(() => this.reply(message, text))
            .catch((error) => Logger.error('[Bridge] 处理消息失败：', error?.message ?? error))
    }

    /** 交给 DSH 生成回复并回发到 QQ。 */
    private async reply(message: QqMessage, text: string): Promise<void> {
        let reply = ''
        try {
            const result = await this.dsh.chat(sessionKey(message.kind, message.id), this.buildPrompt(text))
            reply = result.text.trim()
            this.persistSessions()
        } catch(error) {
            Logger.error(`[Bridge] 会话 ${message.kind}:${message.id} 取回复失败：`, error?.message ?? error)
            return
        }
        if (!reply) return

        try {
            await this.snowLuma.sendMessage(message.kind, message.id, reply)
        } catch(error) {
            Logger.error(`[Bridge] 回复 ${message.kind}:${message.id} 失败：`, error?.message ?? error)
            return
        }

        this.state.pushMessage({
            at: Date.now(),
            direction: 'out',
            kind: message.kind,
            id: message.id,
            name: message.kind === 'group' ? `${message.id}/${message.nickname}` : message.nickname,
            text: reply,
            viaDsh: true,
        })
    }

    /** 是否允许处理这条消息：名单为空时看 allowAllWhenEmpty（默认不放行）。 */
    private isAllowed(message: QqMessage): boolean {
        const allow = this.state.getAllow()
        const list = message.kind === 'group' ? allow.groups : allow.private
        const id = message.kind === 'group' ? message.id : message.userId
        if (list.length === 0) return allow.allowAllWhenEmpty
        return list.includes(id)
    }

    /** 人格卡作为每条消息的前缀注入（成本护栏在 PersonaManager 里）。 */
    private buildPrompt(text: string): string {
        const prefix = this.persona.buildPrefix()
        return prefix ? `${prefix}\n\n${text}` : text
    }

    /** 把 DSH 的会话映射写回运行态，重启后能接着用同一个会话。 */
    private persistSessions(): void {
        const sessions = this.dsh.getSessions()
        for (const [key, sessionId] of Object.entries(sessions)) {
            if (this.state.getSessions()[key] !== sessionId) this.state.setSession(key, sessionId)
        }
    }
}
