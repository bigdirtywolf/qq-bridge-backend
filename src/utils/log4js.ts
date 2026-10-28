    // src/utils/log4js.ts
    import * as Path from 'path';
    import * as Log4js from 'log4js';
    import * as Util from 'util';
    import * as StackTrace from 'stacktrace-js';
    import Chalk from 'chalk';
    import log4jsConfig from '../config/log4js';
    import { format } from 'date-fns';

    // 日志级别
    export enum LoggerLevel {
    ALL = 'ALL',
    MARK = 'MARK',
    TRACE = 'TRACE',
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
    FATAL = 'FATAL',
    OFF = 'OFF',
    }

    // 内容跟踪类
    export class ContextTrace {
    constructor(
        public readonly context: string,
        public readonly path?: string,
        public readonly lineNumber?: number,
        public readonly columnNumber?: number,
    ) {}
    }

    Log4js.addLayout('Awesome-nest', (logConfig: any) => {
        return (logEvent: Log4js.LoggingEvent): string => {
            let moduleName: string = '';
            let position: string = '';

            const messageList: string[] = [];
            logEvent.data.forEach((value: any) => {
                if (value instanceof ContextTrace) {
                    moduleName = value.context;
                    if (value.lineNumber && value.columnNumber) {
                        position = `${value.lineNumber}, ${value.columnNumber}`;
                    }
                    return;
                }

                if (typeof value !== 'string') {
                    value = Util.inspect(value, false, 3, true);
                }

                messageList.push(value);
            });


            const messageOutput: string = messageList.join(' ');
            const positionOutput: string = position ? ` [${position}]` : '';
            const typeOutput: string = `[${logConfig.type}] ${logEvent.pid.toString()}   - `;
            const dateOutput: string = `${format(logEvent.startTime, 'YYYY-MM-DD HH:mm:ss')}`;
            const moduleOutput: string = moduleName ? `[${moduleName}] ` : '[LoggerService] ';
            let levelOutput: string = `[${logEvent.level}] ${messageOutput}`;

            switch (logEvent.level.toString()) {
            case LoggerLevel.DEBUG:
                levelOutput = Chalk.green(levelOutput);
                break;
            case LoggerLevel.INFO:
                levelOutput = Chalk.cyan(levelOutput);
                break;
            case LoggerLevel.WARN:
                levelOutput = Chalk.yellow(levelOutput);
                break;
            case LoggerLevel.ERROR:
                levelOutput = Chalk.red(levelOutput);
                break;
            case LoggerLevel.FATAL:
                levelOutput = Chalk.hex('#DD4C35')(levelOutput);
                break;
            default:
                levelOutput = Chalk.grey(levelOutput);
                break;
            }

            return `${Chalk.green(typeOutput)}${dateOutput}  ${Chalk.yellow(moduleOutput)}${levelOutput}${positionOutput}`;
        };
    });

    Log4js.configure(log4jsConfig);

    const logger = Log4js.getLogger();
    logger.level = LoggerLevel.TRACE;

    export class Logger {
    static trace(...args) {
        logger.trace(Logger.getStackTrace(), ...args);
    }

    static debug(...args) {
        logger.debug(Logger.getStackTrace(), ...args);
    }

    static log(...args) {
        logger.info(Logger.getStackTrace(), ...args);
    }

    static info(...args) {
        logger.info(Logger.getStackTrace(), ...args);
    }

    static warn(...args) {
        logger.warn(Logger.getStackTrace(), ...args);
    }

    static warning(...args) {
        logger.warn(Logger.getStackTrace(), ...args);
    }

    static error(...args) {
        logger.error(Logger.getStackTrace(), ...args);
    }

    static fatal(...args) {
        logger.fatal(Logger.getStackTrace(), ...args);
    }

    static access(...args) {
        const loggerCustom = Log4js.getLogger('http');
        loggerCustom.info(Logger.getStackTrace(), ...args);
    }

    static getStackTrace(deep: number = 2): string {
        const stackList: StackTrace.StackFrame[] = StackTrace.getSync();
        const stackInfo: StackTrace.StackFrame = stackList[deep];

        const lineNumber = stackInfo.lineNumber;
        const columnNumber = stackInfo.columnNumber;
        const fileName = stackInfo.fileName || '';
        const basename = Path.basename(fileName, '.log');
        return `${basename}(line: ${lineNumber}, column: ${columnNumber}): \n`;
    }
}