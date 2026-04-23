import http from 'http';
import app from './app.js';
import logger from './config/logger.js';
import env from './config/env.js';
import { connectMongo } from './config/db.js';

const server = http.createServer(app);

const shutdown = async (signal) => {
  logger.info({ signal }, 'Received shutdown signal, closing server gracefully');

  server.close((err) => {
    if (err) {
      logger.error({ error: err }, 'Error during server shutdown');
      process.exit(1);
    }

    logger.info('Server closed successfully');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

const start = async () => {
  try {
    await connectMongo();

    server.listen(env.port, () => {
      logger.info({ port: env.port, env: env.nodeEnv }, 'Frontly Dentally Service started successfully');
      logger.info(`Health check:         GET  http://localhost:${env.port}/health`);
      logger.info(`Get availability:     GET  http://localhost:${env.port}/dentally/availability`);
      logger.info(`Book appointment:     POST http://localhost:${env.port}/dentally/book`);
      logger.info(`Register patient:     POST http://localhost:${env.port}/dentally/register-patient`);
      logger.info(`Register business:    POST http://localhost:${env.port}/business/register`);
    });

    server.on('error', (error) => {
      if (error.code === 'EACCES') {
        logger.error(`Port ${env.port} requires elevated privileges`);
      } else if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${env.port} is already in use`);
      } else {
        logger.error({ error }, 'Server error');
      }
      process.exit(1);
    });

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      logger.fatal({ error }, 'Uncaught exception');
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.fatal({ reason, promise }, 'Unhandled promise rejection');
      process.exit(1);
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
};

start();
