import env from '../config/env.js';
import logger from '../config/logger.js';
import Practice from '../models/Practice.js';

const BASE_URL = 'https://api.sandbox.dentally.co';

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
// Practitioner Endpoints
// ============================================================================

export async function getPractitionersByRole(apiKey, userAgent, siteId, role) {
  const url = `${BASE_URL}/v1/practitioners?site_id=${encodeURIComponent(siteId)}`;

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

export async function getAvailability(apiKey, userAgent, { practitionerIds, startTime, finishTime, duration }) {
  const query = new URLSearchParams();
  for (const id of practitionerIds) {
    query.append('practitioner_ids[]', id);
  }
  query.set('start_time', startTime);
  query.set('finish_time', finishTime);
  if (duration) query.set('duration', duration);

  const url = `${BASE_URL}/v1/appointments/availability?${query}`;

  const { ok, status, data } = await dentallyFetch('getAvailability', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ practitionerIds, status, body: data }, 'Dentally get availability failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to fetch availability from Dentally');
  }

  return data;
}

export async function listPatientAppointments(apiKey, userAgent, { patientId, siteId }) {
  const query = new URLSearchParams({ patient_id: patientId });
  if (siteId) query.set('site_id', siteId);

  const url = `${BASE_URL}/v1/appointments?${query}`;

  const { ok, status, data } = await dentallyFetch('listPatientAppointments', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ patientId, status, body: data }, 'Dentally list patient appointments failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to fetch appointments from Dentally');
  }

  return data;
}

export async function updateAppointment(apiKey, userAgent, appointmentId, fields) {
  const { ok, status, data } = await dentallyFetch(
    'updateAppointment',
    `${BASE_URL}/v1/appointments/${appointmentId}`,
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
    throw new DentallyApiError(status, (data && data.message) || 'Failed to update appointment in Dentally');
  }

  return data;
}

export async function bookAppointment(apiKey, userAgent, { startTime, finishTime, practitionerId, reason, patientId, state, notes }) {
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
    `${BASE_URL}/v1/appointments`,
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
    throw new DentallyApiError(status, (data && data.message) || 'Failed to book appointment in Dentally');
  }

  return data;
}

// ============================================================================
// Site Endpoints
// ============================================================================

export async function getSiteDefaultPaymentPlanId(apiKey, userAgent, siteId) {
  const url = `${BASE_URL}/v1/sites/${encodeURIComponent(siteId)}`;

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

export async function searchPatients(apiKey, userAgent, { query, siteId }) {
  const params = new URLSearchParams({ query });
  if (siteId) params.set('site_id', siteId);

  const url = `${BASE_URL}/v1/patients?${params}`;
  console.log(" ----------- URL : ", url)
  const { ok, status, data } = await dentallyFetch('searchPatients', url, apiKey, userAgent);

  if (!ok) {
    logger.error({ query, status, body: data }, 'Dentally search patients failed');
    throw new DentallyApiError(status, (data && data.message) || 'Failed to search patients in Dentally');
  }

  return data?.patients ?? [];
}

export async function updatePatient(apiKey, userAgent, patientId, fields) {
  const { ok, status, data } = await dentallyFetch(
    'updatePatient',
    `${BASE_URL}/v1/patients/${patientId}`,
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

export async function registerPatient(apiKey, userAgent, { title, firstName, lastName, dateOfBirth, gender, addressLine1, postcode, siteId, paymentPlanId, mobilePhone, emailAddress }) {
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
    `${BASE_URL}/v1/patients`,
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
