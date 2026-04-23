import pino from 'pino';
import env from './env.js';

const isDevelopment = env.nodeEnv === 'development';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  base: {
    service: 'frontly-dentally',
    env: env.nodeEnv,
  },

  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'apiKey'],
    censor: '[REDACTED]',
  },
});

export default logger;
