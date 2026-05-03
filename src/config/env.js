import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const required = (key, fallback = undefined) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),
  logFullPayloads: process.env.LOG_FULL_PAYLOADS !== 'false',

  apiKey: required('API_KEY'),

  mongoUri: required('MONGO_URI'),

  // Metrics
  metricsIntervalMs: parseInt(process.env.METRICS_INTERVAL_SECS || '60', 10) * 1000,

  // Alerting — all optional. Alerting is silently disabled if ALERT_EMAIL_SERVICE_URL is not set.
  alertEmailServiceUrl:        process.env.ALERT_EMAIL_SERVICE_URL   || null,
  alertEmailApiKey:            process.env.ALERT_EMAIL_API_KEY        || null,
  alertFrom:                   process.env.ALERT_FROM                 || null,
  alertTo:                     process.env.ALERT_TO                   || null, // comma-separated
  alertErrorRateThresholdPct:  parseFloat(process.env.ALERT_ERROR_RATE_THRESHOLD_PCT  || '1'),
  alertCooldownMins:           parseInt(process.env.ALERT_COOLDOWN_MINS || '30', 10),
});

export default env;
