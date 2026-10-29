import { IsBoolean, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** 连接状态取值。 */
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

/** DSH 会话的鉴权策略：minted=离线铸造 Cookie，token=启动 token 交换，none=未鉴权。 */
export type DshAuthStrategy = 'minted' | 'token' | 'none';

/** SnowLuma 连接参数（全部可选，缺省时按配置/自动发现处理）。 */
export class SnowLumaOptions {
    /** SnowLuma 主目录（里面有 config/onebot_<QQ号>.json）。 */
    @IsOptional()
    @IsString()
    homeDir?: string

    /** SnowLuma 启动器路径；填了就从它所在目录找配置。 */
    @IsOptional()
    @IsString()
    launcherPath?: string

    /** OneBot HTTP API 地址，默认 http://127.0.0.1:3000。 */
    @IsOptional()
    @IsString()
    httpUrl?: string

    /** 显式指定的 OneBot 访问令牌；留空则从 SnowLuma 配置里自动发现。 */
    @IsOptional()
    @IsString()
    accessToken?: string

    /** 经接口平台连接时为 true：不回落到 SnowLuma 目录里找令牌。 */
    @IsOptional()
    @IsBoolean()
    viaPlatform?: boolean
}

/** DSH 连接参数（全部可选）。 */
export class DshOptions {
    /** DSH Web API 基址；留空则自动识别（桌面版随机端口 / CLI 3080）。 */
    @IsOptional()
    @IsString()
    baseUrl?: string

    /** DSH 进程启动 token；留空则优先用持久化密钥离线铸造 Cookie。 */
    @IsOptional()
    @IsString()
    authToken?: string

    /** 是否允许把启动 token 发往非回环地址（默认 false）。 */
    @IsOptional()
    @IsBoolean()
    allowRemote?: boolean

    /** 等一次助手回复的超时（毫秒），默认 180 秒。 */
    @IsOptional()
    @IsInt()
    replyTimeoutMs?: number

    /** 新建会话时使用的智能体预设；留空用 DSH 默认预设。 */
    @IsOptional()
    @IsString()
    agentPreset?: string

    /** 工作区标题；只在这个工作区是首次创建时写入，不会覆盖用户改过的标题。 */
    @IsOptional()
    @IsString()
    workspaceTitle?: string

    /** 钉住会话的模型与推理强度：provider 与 model 都填了才生效。 */
    @IsOptional()
    @IsString()
    provider?: string

    @IsOptional()
    @IsString()
    model?: string

    @IsOptional()
    @IsString()
    reasoningEffort?: string
}

/** POST /bridge/connect 请求体。 */
export class ConnectDTO {
    @IsOptional()
    @ValidateNested()
    @Type(() => SnowLumaOptions)
    snowLuma?: SnowLumaOptions

    @IsOptional()
    @ValidateNested()
    @Type(() => DshOptions)
    dsh?: DshOptions
}

/** SnowLuma 运行时状态（返回给前端）。 */
export interface SnowLumaState {
    status: ConnectionStatus
    /** WebSocket 地址（收事件）。 */
    wsUrl: string
    /** HTTP API 地址（发消息/查询）。 */
    httpUrl: string
    /** 脱敏后的访问令牌。 */
    token: string
    /** 登录账号信息。 */
    self: { userId: string; nickname: string } | null
    lastError: string | null
    /** 令牌来源：config/env / onebot_<QQ号>.json / no-token。 */
    source: string | null
    /** 最近一次收到上游事件的时间戳（连上了 ≠ 收得到）。 */
    lastEventAt: number | null
    /** 上游心跳里的 status.good；null 表示还没收到过心跳。 */
    heartbeatGood: boolean | null
    reconnectAttempts: number
    updatedAt: number
}

/** DSH 事件流状态。 */
export interface DshEventStreamState {
    status: ConnectionStatus
    /** 已收到 ready 帧（服务端已接受 $events 订阅）。 */
    ready: boolean
    lastError: string | null
}

/** DSH 运行时状态（返回给前端）。 */
export interface DshState {
    status: ConnectionStatus
    baseUrl: string
    /** 基址是否由本模块自动识别得出。 */
    auto: boolean
    /** 基址端口是否可连。 */
    reachable: boolean
    authStrategy: DshAuthStrategy
    /** 探活（settings/describe）是否通过。 */
    ready: boolean
    eventStream: DshEventStreamState
    lastError: string | null
    lastCheckAt: number | null
    updatedAt: number
}

/** GET /bridge/status 响应体。 */
export interface BridgeStatusDTO {
    snowLuma: SnowLumaState
    dsh: DshState
}
