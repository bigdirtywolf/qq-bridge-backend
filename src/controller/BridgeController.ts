import { Body, Controller, Get, Post } from "@nestjs/common";
import { ConnectDTO } from "src/dto/ConnectionDTO";
import { BridgeService } from "src/service/BridgeService";

@Controller('bridge')
export class BridgeController {
    constructor(
        private readonly bridgeService: BridgeService,
    ) {}

    @Post('connect')
    connect(@Body() connectDTO: ConnectDTO) {
        return this.bridgeService.connect(connectDTO)
    }

    @Post('disconnect')
    disconnect() {
        return this.bridgeService.disconnect()
    }

    @Get('status')
    status() {
        return this.bridgeService.status()
    }
}
