import logger from '../config/logger.js';
import env from '../config/env.js';

export function requestPayloadLogger(req, res, next) {
  if (!env.logFullPayloads) return next();
  if (req.method === 'GET' && req.path === '/health') return next();

  const payload = {
    incoming: true,
    method: req.method,
    route: `${req.baseUrl}${req.path}`,
  };

  if (req.query && Object.keys(req.query).length > 0) {
    payload.query = req.query;
  }

  if (req.body !== undefined && req.body !== null) {
    const isEmptyObject =
      typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
    if (!isEmptyObject) {
      payload.body = req.body;
    }
  }

  logger.info(payload, 'Incoming API request');
  next();
}
