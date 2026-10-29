import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ConnectDTO } from "src/dto/ConnectionDTO";
import { BridgeConfigDTO, ChatDTO, PersonaCreateDTO, PersonaNameDTO, PersonaSaveDTO, ToolsConfigDTO } from "src/dto/BridgeDTO";
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

    @Post('chat')
    chat(@Body() chatDTO: ChatDTO) {
        return this.bridgeService.sendMessage(chatDTO)
    }

    @Get('messages')
    messages(@Query('limit') limit?: string) {
        return this.bridgeService.messages(limit)
    }

    @Post('messages/clear')
    clearMessages() {
        return this.bridgeService.clearMessages()
    }

    @Get('config')
    config() {
        return this.bridgeService.config()
    }

    @Post('config')
    setConfig(@Body() bridgeConfigDTO: BridgeConfigDTO) {
        return this.bridgeService.setConfig(bridgeConfigDTO)
    }

    @Get('persona')
    personaList() {
        return this.bridgeService.personaList()
    }

    @Get('persona/detail')
    personaDetail(@Query('name') name: string) {
        return this.bridgeService.personaDetail(name)
    }

    @Post('persona/create')
    personaCreate(@Body() personaCreateDTO: PersonaCreateDTO) {
        return this.bridgeService.personaCreate(personaCreateDTO)
    }

    @Post('persona/save')
    personaSave(@Body() personaSaveDTO: PersonaSaveDTO) {
        return this.bridgeService.personaSave(personaSaveDTO)
    }

    @Post('persona/delete')
    personaDelete(@Body() personaNameDTO: PersonaNameDTO) {
        return this.bridgeService.personaDelete(personaNameDTO)
    }

    @Get('tools')
    tools() {
        return this.bridgeService.tools()
    }

    @Post('tools')
    setTools(@Body() toolsConfigDTO: ToolsConfigDTO) {
        return this.bridgeService.setTools(toolsConfigDTO)
    }
}
