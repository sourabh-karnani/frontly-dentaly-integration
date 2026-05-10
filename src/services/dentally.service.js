import env from '../config/env.js';
import logger from '../config/logger.js';
import Practice from '../models/Practice.js';
import RoundRobinCounter from '../models/RoundRobinCounter.js';

const SANDBOX_URL = 'https://api.sandbox.dentally.co';
const PRODUCTION_URL = 'https://api.dentally.co';

const PRODUCTION_PRACTICE_IDS = [
  // Add frontly_practice_id strings here for practices that should hit production
  // e.g. 'practice_001',
];

export function getBaseUrl(frontlyPracticeId) {
  return PRODUCTION_PRACTICE_IDS.includes(frontlyPracticeId) ? PRODUCTION_URL : SANDBOX_URL;
}

// ============================================================================
// Error Class
// ============================================================================

export class DentallyApiError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = 'DentallyApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Map a 4xx Dentally error body to a typed { code, message, statusCode } so consumers get an
 * actionable signal instead of a generic "Dentally API Error". Dentally returns errors as:
 *   { error: { type: "invalid_request_error", message: "...", params: {field:[reason,...]} } }
 *
 * The `params` object carries the real reason. We translate the most common ones into codes
 * the LLM tool handlers (calendar-tools-dentally.js) already branch on.
 */
function classifyDentallyBookingError(status, body) {
  const params = body?.error?.params || body?.params || {};
  const upstreamMessage = body?.error?.message || body?.message;
  const flatten = Object.entries(params).flatMap(([field, msgs]) =>
    (Array.isArray(msgs) ? msgs : [msgs]).map((m) => `${field}: ${m}`)
  );
  const joined = flatten.join(' | ').toLowerCase();

  if (/has at least one existing appointment|already.*book|existing appointment/.test(joined)) {
    return { code: 'TIME_SLOT_ALREADY_BOOKED', statusCode: 409, message: 'This time slot is already booked' };
  }
  if (/past|cannot be in the past|must be in the future/.test(joined)) {
    return { code: 'PAST_TIME_NOT_ALLOWED', statusCode: 400, message: 'Appointment time cannot be in the past' };
  }
  if (/outside.*business hours|outside.*hours|not within working|outside working/.test(joined)) {
    return { code: 'OUTSIDE_BUSINESS_HOURS', statusCode: 400, message: 'Appointment is outside business hours' };
  }
  if (/must be greater than 24 hours|must be less than|finish_time/.test(joined)) {
    return { code: 'VALIDATION_ERROR', statusCode: 400, message: upstreamMessage || flatten.join('; ') || 'Validation failed' };
  }
  // Fallback: surface the real reason if we have one
  return {
    code: 'DENTALLY_API_ERROR',
    statusCode: status,
    message: flatten.length ? flatten.join('; ') : (upstreamMessage || 'Failed to book appointment in Dentally'),
  };
}

// ============================================================================
// Config Lookup
// ============================================================================

export async function getPracticeConfig(businessIdentifier) {
  const practice = await Practice.findOne({ business_identifier: businessIdentifier, isActive: true });

  if (!practice) {
    throw new DentallyApiError(404, `Practice not found for identifier: ${businessIdentifier}`, 'PRACTICE_NOT_FOUND');
  }

  return practice;
}

// ============================================================================
// Fetch Wrapper
// ============================================================================

async function dentallyFetch(operation, url, apiKey, userAgent, init = {}) {
  let requestBody = null;
  if (init.body != null) {
    try {
      requestBody = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    } catch {
      requestBody = init.body;
    }
  }

  if (env.logFullPayloads) {
    logger.info(
      { dentally: true, operation, method: init.method || 'GET', url, requestBody },
      'Dentally API request'
    );
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': userAgent,
      ...init.headers,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (env.logFullPayloads) {
    logger.info(
      { dentally: true, operation, status: res.status, ok: res.ok, responseBody: data },
      'Dentally API response'
    );
  }

  return { status: res.status, ok: res.ok, data };
}

// ============================================================================
// Round-Robin Counter (MongoDB-backed — survives restarts)
// ============================================================================

/**
 * Atomically increment a per-key counter and return the picked element from `ids`.
 * Counter persists in MongoDB (`round_robin_counters` collection), so picks are
 * stable across service restarts and multiple process replicas.
 */
export async function pickRoundRobin(key, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('pickRoundRobin: ids must be a non-empty array');
  }
  const doc = await RoundRobinCounter.findOneAndUpdate(
    { key },
    { $inc: { count: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const idx = (doc.count - 1) % ids.length;
  return ids[idx];
}

// ============================================================================
// Practitioner Endpoints
// ============================================================================

export async function getPractitionersByRole(apiKey, userAgent, baseUrl, siteId, role) {
  const url = `${baseUrl}/v1/practitioners?site_id=${encodeURIComponent(siteId)}`;

  const { ok, status, data } = await dentallyFetch('getPractitionersByRole', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ siteId, role, status, body: data }, 'Dentally get practitioners failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to fetch practitioners from Dentally');
  }

  const practitioners = data?.practitioners ?? [];
  return practitioners
    .filter((p) => p.active === true && p.user?.role?.toLowerCase() === role.toLowerCase())
    .map((p) => p.id);
}

// ============================================================================
// Appointment Endpoints
// ============================================================================

export async function getAvailability(apiKey, userAgent, baseUrl, { practitionerIds, startTime, finishTime, duration }) {
  const query = new URLSearchParams();
  for (const id of practitionerIds) {
    query.append('practitioner_ids[]', id);
  }
  query.set('start_time', startTime);
  query.set('finish_time', finishTime);
  if (duration) query.set('duration', duration);

  const url = `${baseUrl}/v1/appointments/availability?${query}`;

  const { ok, status, data } = await dentallyFetch('getAvailability', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ practitionerIds, status, body: data }, 'Dentally get availability failed');
    const classified = classifyDentallyBookingError(status, data);
    throw new DentallyApiError(classified.statusCode, classified.message, classified.code);
  }

  return data;
}

export async function listPatientAppointments(apiKey, userAgent, baseUrl, { patientId, siteId }) {
  const query = new URLSearchParams({ patient_id: patientId });
  if (siteId) query.set('site_id', siteId);

  const url = `${baseUrl}/v1/appointments?${query}`;

  const { ok, status, data } = await dentallyFetch('listPatientAppointments', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ patientId, status, body: data }, 'Dentally list patient appointments failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to fetch appointments from Dentally');
  }

  return data;
}

export async function updateAppointment(apiKey, userAgent, baseUrl, appointmentId, fields) {
  const { ok, status, data } = await dentallyFetch(
    'updateAppointment',
    `${baseUrl}/v1/appointments/${appointmentId}`,
    apiKey,
    userAgent,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointment: fields }),
    }
  );

  if (!ok) {
    logger.error({ appointmentId, fields, status, body: data }, 'Dentally update appointment failed');
    const classified = classifyDentallyBookingError(status, data);
    throw new DentallyApiError(classified.statusCode, classified.message, classified.code);
  }

  return data;
}

export async function bookAppointment(apiKey, userAgent, baseUrl, { startTime, finishTime, practitionerId, reason, patientId, state, notes }) {
  const appointment = {
    start_time: startTime,
    finish_time: finishTime,
    practitioner_id: practitionerId,
    reason,
  };

  if (patientId !== undefined) appointment.patient_id = patientId;
  if (state !== undefined) appointment.state = state;
  if (notes !== undefined) appointment.notes = notes;

  const { ok, status, data } = await dentallyFetch(
    'bookAppointment',
    `${baseUrl}/v1/appointments`,
    apiKey,
    userAgent,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointment }),
    }
  );

  if (!ok) {
    logger.error({ practitionerId, status, body: data }, 'Dentally book appointment failed');
    const classified = classifyDentallyBookingError(status, data);
    throw new DentallyApiError(classified.statusCode, classified.message, classified.code);
  }

  return data;
}

// ============================================================================
// Site Endpoints
// ============================================================================

export async function getSiteDefaultPaymentPlanId(apiKey, userAgent, baseUrl, siteId) {
  const url = `${baseUrl}/v1/sites/${encodeURIComponent(siteId)}`;

  const { ok, status, data } = await dentallyFetch('getSiteDefaultPaymentPlanId', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ siteId, status, body: data }, 'Dentally get site failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to fetch site from Dentally');
  }

  const paymentPlanId = data?.site?.default_payment_plan_id;
  if (!paymentPlanId) {
    throw new DentallyApiError(502, `No default payment plan configured for site: ${siteId}`, 'NO_DEFAULT_PAYMENT_PLAN');
  }

  return paymentPlanId;
}

// ============================================================================
// Patient Endpoints
// ============================================================================

export async function searchPatients(apiKey, userAgent, baseUrl, { query, siteId }) {
  // Dentally's ?query= returns 0 phone matches when the value contains a literal '+'
  // (URLSearchParams encodes '+' as '%2B', which Dentally treats as a non-digit and
  // breaks phone matching). Strip a leading '+' so phone queries work consistently.
  const sanitizedQuery = typeof query === 'string' && query.startsWith('+') ? query.slice(1) : query;

  const params = new URLSearchParams({ query: sanitizedQuery });
  if (siteId) params.set('site_id', siteId);

  const url = `${baseUrl}/v1/patients?${params}`;
  const { ok, status, data } = await dentallyFetch('searchPatients', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ query, status, body: data }, 'Dentally search patients failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to search patients in Dentally');
  }

  return data?.patients ?? [];
}

/**
 * Look up a single patient by name. When multiple patients match (e.g. duplicate test
 * patients created by historical placeholder logic), pick the most recently updated one
 * — older duplicates are usually stale placeholders, so the freshest record is the most
 * likely "real" patient. Returns null if nothing matched.
 */
export async function findPatientByName(apiKey, userAgent, baseUrl, { name, siteId }) {
  const results = await searchPatients(apiKey, userAgent, baseUrl, { query: name, siteId });
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  const ts = (p) => {
    const t = Date.parse(p.updated_at || p.created_at || '');
    return Number.isFinite(t) ? t : 0;
  };
  return [...results].sort((a, b) => ts(b) - ts(a))[0];
}

/**
 * Look up a single patient by phone number.
 *
 * Multiple Dentally patients can share normalised phone fragments (real patient + leftover
 * placeholders), so this helper prefers a patient whose actual mobile/home/work phone digits
 * match the searched phone exactly. Falls back to the first result if no exact digit match.
 *
 * @returns the matched patient object, or null if nothing matched.
 */
export async function findPatientByPhone(apiKey, userAgent, baseUrl, { phone, siteId }) {
  // Strip all non-digit characters before searching. Dentally's ?query= rejects
  // literal '+', spaces, dashes, brackets, etc. as phone-match characters,
  // so a digits-only query is the most reliable lookup form.
  const searchedDigits = String(phone).replace(/\D/g, '');
  if (!searchedDigits) return null;

  const results = await searchPatients(apiKey, userAgent, baseUrl, { query: searchedDigits, siteId });
  if (results.length === 0) return null;

  const phoneDigits = (p) =>
    [p.mobile_phone, p.home_phone, p.work_phone]
      .filter(Boolean)
      .map((f) => String(f).replace(/\D/g, ''));

  const exact = results.find((p) => phoneDigits(p).some((d) => d === searchedDigits));
  if (exact) return exact;

  const suffix = results.find((p) =>
    phoneDigits(p).some((d) => d.endsWith(searchedDigits) || searchedDigits.endsWith(d))
  );
  if (suffix) return suffix;

  return results[0];
}

export async function updatePatient(apiKey, userAgent, baseUrl, patientId, fields) {
  const { ok, status, data } = await dentallyFetch(
    'updatePatient',
    `${baseUrl}/v1/patients/${patientId}`,
    apiKey,
    userAgent,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient: fields }),
    }
  );

  if (!ok) {
    logger.error({ patientId, fields, status, body: data }, 'Dentally update patient failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to update patient in Dentally');
  }

  return data;
}

export async function registerPatient(apiKey, userAgent, baseUrl, { title, firstName, lastName, dateOfBirth, gender, addressLine1, postcode, siteId, paymentPlanId, mobilePhone, emailAddress }) {
  const patient = {
    title,
    first_name: firstName,
    last_name: lastName,
    date_of_birth: dateOfBirth,
    gender,
    address_line_1: addressLine1,
    postcode,
    payment_plan_id: paymentPlanId,
    ethnicity: '99',
    site_id: siteId,
  };

  if (mobilePhone !== undefined) patient.mobile_phone = mobilePhone;
  if (emailAddress !== undefined) patient.email_address = emailAddress;

  const { ok, status, data } = await dentallyFetch(
    'registerPatient',
    `${baseUrl}/v1/patients`,
    apiKey,
    userAgent,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patient }),
    }
  );

  if (!ok) {
    logger.error({ firstName, lastName, status, body: data }, 'Dentally register patient failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to register patient in Dentally');
  }

  return data;
}
