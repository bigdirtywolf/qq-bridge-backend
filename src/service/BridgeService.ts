import { DshManager } from "src/const/DshManager";
import { ResultData } from "src/const/Result";
import { SnowLumaManager } from "src/const/SnowLumaManager";
import { BridgeStatusDTO, ConnectDTO } from "src/dto/ConnectionDTO";

/** 桥接服务：持有 SnowLuma 与 DSH 两个连接管理器，对外暴露连接/断开/状态。 */
export class BridgeService {
    private snowLuma: SnowLumaManager
    private dsh: DshManager

    constructor() {
        // 先建好「未连接」的实例：状态接口在任何时刻都能返回完整结构，前端不用判空。
        this.snowLuma = new SnowLumaManager()
        this.dsh = new DshManager()
    }

    /** 按传入参数连接 SnowLuma 与 DSH；重复调用会先断开旧连接。 */
    async connect(connectDTO: ConnectDTO) {
        try {
            this.close()

            this.snowLuma = new SnowLumaManager(connectDTO.snowLuma ?? {})
            this.dsh = new DshManager(connectDTO.dsh ?? {})
            this.snowLuma.start()
            this.dsh.start()

            return ResultData.success(this.snapshot())
        } catch(error) {
            console.log(error)
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
}
