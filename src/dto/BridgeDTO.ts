import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';

/** 一条 QQ 消息（OneBot v11 事件归一化后的形状）。 */
export interface QqMessage {
    /** private=私聊，group=群聊。 */
    kind: 'private' | 'group'
    /** 私聊为对方 QQ 号，群聊为群号。 */
    id: string
    /** 发送者 QQ 号。 */
    userId: string
    /** 发送者昵称（群里优先用群名片）。 */
    nickname: string
    /** 纯文本内容（CQ 码与图片等非文本段已剔除）。 */
    text: string
    /** 是否 @ 了机器人（群聊里用来判断要不要回）。 */
    atMe: boolean
    messageId: string | null
    at: number
}

/** POST /bridge/chat 请求体：手动发一条消息，可选择交给 DSH 生成回复。 */
export class ChatDTO {
    @IsIn(['private', 'group'])
    kind: 'private' | 'group'

    /** 私聊传 QQ 号，群聊传群号。 */
    @IsString()
    id: string

    @IsString()
    text: string

    /** true=把消息交给 DSH 生成回复后再发（默认），false=原样直发。 */
    @IsOptional()
    @IsBoolean()
    viaDsh?: boolean
}

/** POST /bridge/config 请求体：允许名单。 */
export class AllowConfigDTO {
    @IsOptional()
    @IsArray()
    private?: string[]

    @IsOptional()
    @IsArray()
    groups?: string[]

    @IsOptional()
    @IsBoolean()
    allowAllWhenEmpty?: boolean
}

/** POST /bridge/config 请求体：人格的运行态设置。 */
export class PersonaConfigDTO {
    /** 当前启用人格名；空字符串=清除。 */
    @IsOptional()
    @IsString()
    current?: string

    @IsOptional()
    @IsInt()
    maxInjectChars?: number
}

/** POST /bridge/config 请求体。 */
export class BridgeConfigDTO {
    @IsOptional()
    allow?: AllowConfigDTO

    @IsOptional()
    persona?: PersonaConfigDTO
}

/** POST /bridge/persona/save 请求体：保存人格卡正文。 */
export class PersonaSaveDTO {
    @IsString()
    name: string

    @IsString()
    content: string
}

/** POST /bridge/persona/create 请求体：新建人格卡（content 留空时写入模板）。 */
export class PersonaCreateDTO {
    @IsString()
    name: string

    @IsOptional()
    @IsString()
    content?: string
}

/** POST /bridge/persona/delete 请求体。 */
export class PersonaNameDTO {
    @IsString()
    name: string
}

/**
 * POST /bridge/tools 请求体：要开放给 DSH 的 QQ 动作名单。
 *
 * 传空数组表示「一个都不开放」（等价于摘掉 DSH 侧的 MCP 条目），
 * 与「还没配置过」是两件事，所以这里不接受 null/undefined。
 */
export class ToolsConfigDTO {
    @IsArray()
    @IsString({ each: true })
    enabled: string[]
}
