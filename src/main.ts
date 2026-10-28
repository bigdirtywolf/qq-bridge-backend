import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cors from 'cors';
import * as express from 'express';
import { RouterInterceptor } from './interceptor/RouterInterceptor';
import { logger } from './middleware/LoggerMiddleware';

async function bootstrap() {

    require('dotenv').config({
        path: `.env.${process.env.NODE_ENV || 'dev'}`,
    });

    console.log('=== 应用启动配置 ===');
    console.log('PORT:', process.env.PORT);
    console.log('==================');

    const app = await NestFactory.create(AppModule);

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(logger);

    app.useGlobalInterceptors(new RouterInterceptor());

    app.use(cors({
        origin: [
            'http://localhost:8000',
            'http://127.0.0.1:8000',
            'http://localhost:5173',
        ],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    }));
    await app.listen(Number(process.env.PORT));
}

bootstrap();
