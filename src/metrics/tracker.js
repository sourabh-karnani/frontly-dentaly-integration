import logger from '../config/logger.js';
import env from '../config/env.js';

// ============================================================================
// In-memory metrics tracker
//
// Tracks per-request data within the current window. On each flush interval
// it logs a single `metrics_summary` line, checks alert thresholds, and resets.
// State is in-memory — resets on service restart, acceptable for lightweight monitoring.
// ============================================================================

// Cooldown state — tracks when each alert type was last sent
let lastErrorRateAlertAt = null;

// ============================================================================
// Window state
// ============================================================================

let windowStart = Date.now();
let totalRequests = 0;
let errors5xx = 0;
let durations = []; // response times (ms) within the current window

// ============================================================================
// Public API
// ============================================================================

/**
 * Record a completed request. Called by the request logging middleware.
 *
 * @param {number} statusCode - HTTP response status code
 * @param {number} durationMs - Request duration in milliseconds
 */
export function recordRequest(statusCode, durationMs) {
  totalRequests++;
  if (statusCode >= 500) errors5xx++;
  durations.push(durationMs);
}

/**
 * Start the periodic metrics reporter.
 * Should be called once after the server starts listening.
 *
 * @returns {NodeJS.Timeout} The interval handle (call clearInterval to stop)
 */
export function startMetricsReporter() {
  logger.info({ intervalMs: env.metricsIntervalMs }, 'Metrics reporter started');
  return setInterval(flush, env.metricsIntervalMs);
}

// ============================================================================
// Internal — flush
// ============================================================================

async function flush() {
  const windowSeconds = Math.round((Date.now() - windowStart) / 1000);
  const sorted = [...durations].sort((a, b) => a - b);

  const errorRatePct =
    totalRequests > 0
      ? parseFloat(((errors5xx / totalRequests) * 100).toFixed(2))
      : 0;

  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  logger.info(
    {
      type: 'metrics_summary',
      window_seconds: windowSeconds,
      total_requests: totalRequests,
      errors_5xx: errors5xx,
      error_rate_pct: errorRatePct,
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      latency_p99_ms: p99,
    },
    'metrics summary'
  );

  // ── Alert checks ────────────────────────────────────────────────────────────
  if (errorRatePct > env.alertErrorRateThresholdPct && isCooledDown(lastErrorRateAlertAt)) {
    lastErrorRateAlertAt = Date.now();
    await sendAlert(
      `🚨 [frontly-dentally] High 500 error rate: ${errorRatePct}%`,
      buildEmailBody({
        headline: `500 error rate is ${errorRatePct}% — threshold is ${env.alertErrorRateThresholdPct}%`,
        windowSeconds,
        totalRequests,
        errors5xx,
        errorRatePct,
        p50,
        p95,
        p99,
      })
    );
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Reset window
  totalRequests = 0;
  errors5xx = 0;
  durations = [];
  windowStart = Date.now();
}

// ============================================================================
// Internal — alerting
// ============================================================================

function isCooledDown(lastAlertAt) {
  if (!lastAlertAt) return true;
  return Date.now() - lastAlertAt > env.alertCooldownMins * 60 * 1000;
}

async function sendAlert(subject, body) {
  const { alertEmailServiceUrl, alertEmailApiKey, alertFrom, alertTo } = env;

  if (!alertEmailServiceUrl || !alertEmailApiKey || !alertFrom || !alertTo) {
    logger.warn({ subject }, 'Alert triggered but email service not configured — skipping');
    return;
  }

  const to = alertTo.split(',').map((e) => e.trim());

  try {
    const res = await fetch(`${alertEmailServiceUrl}/email/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': alertEmailApiKey,
      },
      body: JSON.stringify({ from: alertFrom, to, subject, body }),
    });

    if (res.ok) {
      logger.info({ subject }, 'Alert email sent successfully');
    } else {
      const text = await res.text();
      logger.error({ status: res.status, body: text }, 'Failed to send alert email');
    }
  } catch (err) {
    logger.error({ err }, 'Error calling frontly-email service');
  }
}

function buildEmailBody({ headline, windowSeconds, totalRequests, errors5xx, errorRatePct, p50, p95, p99 }) {
  return [
    headline,
    '',
    `Window        : ${windowSeconds}s`,
    `Total requests: ${totalRequests}`,
    `500 errors    : ${errors5xx}`,
    `Error rate    : ${errorRatePct}%`,
    '',
    `Latency p50   : ${p50 ?? 'n/a'} ms`,
    `Latency p95   : ${p95 ?? 'n/a'} ms`,
    `Latency p99   : ${p99 ?? 'n/a'} ms`,
    '',
    `Time          : ${new Date().toISOString()}`,
    `Service       : frontly-dentally`,
  ].join('\n');
}

// ============================================================================
// Internal — percentile
// ============================================================================

/**
 * Compute the p-th percentile of a pre-sorted array.
 * Returns null if the array is empty.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
