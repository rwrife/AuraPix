import pino from 'pino';
import { serverConfig } from '../config/index.js';

export const logger = pino({
  level: serverConfig.logLevel,
  transport:
    serverConfig.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss',
          },
        }
      : undefined,
});

export function createRequestLogger() {
  return pino({
    level: serverConfig.logLevel,
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        headers: req.headers,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
  });
}