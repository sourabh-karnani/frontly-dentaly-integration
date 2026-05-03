import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import logger from './config/logger.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { requestPayloadLogger } from './middlewares/requestPayloadLogger.js';
import { recordRequest } from './metrics/tracker.js';
import dentallyRoutes from './routes/dentally.routes.js';
import businessRoutes from './routes/business.routes.js';

const app = express();

// ============================================================================
// Security & Parsing Middleware
// ============================================================================

app.set('trust proxy', 1);
app.use(helmet());

app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestPayloadLogger);

// ============================================================================
// Request Logging Middleware
// ============================================================================

app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration_ms = Date.now() - start;
    const { statusCode } = res;
    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    logger[logLevel](
      {
        method: req.method,
        route: (req.baseUrl ?? '') + (req.route?.path ?? req.path),
        status_code: statusCode,
        duration_ms,
        ip: req.ip,
      },
      'request completed'
    );

    recordRequest(statusCode, duration_ms);
  });

  next();
});

// ============================================================================
// Routes
// ============================================================================

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'frontly-dentally',
    timestamp: new Date().toISOString(),
  });
});

app.use('/dentally', dentallyRoutes);
app.use('/business', businessRoutes);

// ============================================================================
// Error Handling
// ============================================================================

app.use(errorHandler);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
    code: 'ROUTE_NOT_FOUND',
  });
});

export default app;
