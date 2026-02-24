import pino from 'pino';

const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
};

if (process.env.NODE_ENV !== 'production') {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: { colorize: true },
  };
}

export const logger = pino(loggerOptions);
