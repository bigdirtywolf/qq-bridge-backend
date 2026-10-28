import {Module} from '@nestjs/common';
import * as controller from './controller'
import * as service from './service'
import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [
        ConfigModule.forRoot({
                envFilePath: `.env.${process.env.NODE_ENV || 'dev'}`,
                isGlobal: true,
            },
        ),
    ],
    controllers: Object.values(controller),
    providers: Object.values(service),
})

export class AppModule {}
