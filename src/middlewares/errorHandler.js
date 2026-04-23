import logger from '../config/logger.js';

export const errorHandler = (err, req, res, next) => {
  logger.error(
    { error: err.message, stack: err.stack, method: req.method, path: req.path, body: req.body },
    'Unhandled error'
  );

  const statusCode = err.statusCode || err.status || 500;
  const isServerError = statusCode >= 500;

  const errorResponse = {
    success: false,
    error: isServerError ? 'Internal Server Error' : err.name || 'Error',
    message: isServerError ? 'An unexpected error occurred' : err.message,
    code: err.code || 'SERVER_ERROR',
  };

  if (process.env.NODE_ENV === 'development' && err.details) {
    errorResponse.details = err.details;
  }

  res.status(statusCode).json(errorResponse);
};
