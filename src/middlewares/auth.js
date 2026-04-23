import logger from '../config/logger.js';
import env from '../config/env.js';

export const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.get('x-api-key');

  if (!apiKey) {
    logger.warn({ method: req.method, path: req.path, ip: req.ip }, 'API key missing from request');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'API key is required',
      code: 'MISSING_API_KEY',
    });
  }

  if (apiKey !== env.apiKey) {
    logger.warn(
      { method: req.method, path: req.path, ip: req.ip, providedKeyPrefix: apiKey.substring(0, 10) },
      'Invalid API key provided'
    );
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid API key',
      code: 'INVALID_API_KEY',
    });
  }

  next();
};
