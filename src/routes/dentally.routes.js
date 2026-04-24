import { Router } from 'express';
import { z } from 'zod';
import logger from '../config/logger.js';
import { requireApiKey } from '../middlewares/auth.js';
import {
  getPracticeConfig,
  getPractitionersByRole,
  getAvailability,
  listPatientAppointments,
  updateAppointment,
  bookAppointment,
  searchPatients,
  getSiteDefaultPaymentPlanId,
  registerPatient,
  updatePatient,
  DentallyApiError,
} from '../services/dentally.service.js';

const router = Router();

// ============================================================================
// Round Robin State (in-memory, resets on restart)
// Key: `${frontly_practice_id}:${practitioner_type}` → next index
// ============================================================================

const rrCounters = new Map();

function pickRoundRobin(key, ids) {
  const idx = rrCounters.get(key) ?? 0;
  const picked = ids[idx % ids.length];
  rrCounters.set(key, idx + 1);
  return picked;
}

// ============================================================================
// Helpers
// ============================================================================

function splitName(name) {
  if (!name) return { firstName: 'Unknown', lastName: 'Patient' };
  const parts = name.trim().split(/\s+/);
  return parts.length === 1
    ? { firstName: parts[0], lastName: 'Patient' }
    : { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ============================================================================
// Validation Schemas
// ============================================================================

const DENTALLY_REASONS = ['Exam', 'Scale & Polish', 'Exam + Scale & Polish', 'Continuing Treatment', 'Emergency', 'Review', 'Other'];
const DENTALLY_STATES = ['Pending', 'Confirmed', 'Arrived', 'In surgery', 'Completed', 'Cancelled', 'Did not attend'];
const PRACTITIONER_TYPES = ['dentist', 'hygienist', 'therapist'];
const PATIENT_TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Dr', 'Master', 'Prof', 'Hon', 'Rev', 'Sir', 'Lady', 'Lord', 'Earl', 'Judge', 'Dame'];

const availabilitySchema = z
  .object({
    business_identifier: z.string().min(1, 'business_identifier is required'),
    start_time: z.string().min(1, 'start_time is required'),
    finish_time: z.string().min(1, 'finish_time is required'),
    practitioner_id: z.coerce.number().int().positive().optional(),
    practitioner_type: z.enum(PRACTITIONER_TYPES).optional(),
    duration: z.coerce.number().int().positive().optional(),
    phone: z.string().optional(),
  })
  .refine((d) => d.practitioner_id !== undefined || d.practitioner_type !== undefined, {
    message: 'Either practitioner_id or practitioner_type is required',
    path: ['practitioner_id'],
  });

const bookSchema = z.object({
  business_identifier: z.string().min(1, 'business_identifier is required'),
  start_time:          z.string().min(1, 'start_time is required'),
  finish_time:         z.string().min(1, 'finish_time is required'),
  practitioner_id:     z.number().int().positive('practitioner_id is required'),
  reason:              z.enum(DENTALLY_REASONS),
  phone:               z.string().optional(),
  name:                z.string().optional(),
  state:               z.enum(DENTALLY_STATES).optional(),
  notes:               z.string().optional(),
});

const listAppointmentsSchema = z.object({
  business_identifier: z.string().min(1, 'business_identifier is required'),
  phone:               z.string().optional(),
  name:                z.string().optional(),
});

const rescheduleSchema = z.object({
  business_identifier: z.string().min(1, 'business_identifier is required'),
  appointment_id:      z.number().int().positive('appointment_id is required'),
  start_time:          z.string().min(1, 'start_time is required'),
  finish_time:         z.string().min(1, 'finish_time is required'),
  practitioner_id:     z.number().int().positive().optional(),
});

const cancelSchema = z.object({
  business_identifier: z.string().min(1, 'business_identifier is required'),
  appointment_id:      z.number().int().positive('appointment_id is required'),
});

const updatePatientSchema = z.object({
  business_identifier: z.string().min(1, 'business_identifier is required'),
  phone:               z.string().optional(),
  name:                z.string().optional(),
  // Update fields — all optional, send only what needs changing
  title:               z.enum(PATIENT_TITLES).optional(),
  first_name:          z.string().optional(),
  last_name:           z.string().optional(),
  middle_name:         z.string().optional(),
  date_of_birth:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender:              z.enum(['male', 'female']).optional(),
  address_line_1:      z.string().optional(),
  address_line_2:      z.string().optional(),
  town:                z.string().optional(),
  county:              z.string().optional(),
  postcode:            z.string().optional(),
  mobile_phone:        z.string().optional(),
  email_address:       z.string().email().optional(),
  home_phone:          z.string().optional(),
  recall_method:       z.enum(['Letter', 'SMS', 'Email', 'Phone']).optional(),
  use_email:           z.boolean().optional(),
  use_sms:             z.boolean().optional(),
}).refine(
  (d) => d.phone !== undefined || d.name !== undefined,
  { message: 'Either phone or name is required to look up the patient', path: ['phone'] }
);

const registerPatientSchema = z.object({
  business_identifier: z.string().min(1, 'business_identifier is required'),
  title:          z.enum(PATIENT_TITLES),
  first_name:     z.string().min(1, 'first_name is required'),
  last_name:      z.string().min(1, 'last_name is required'),
  date_of_birth:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_of_birth must be YYYY-MM-DD'),
  gender:         z.enum(['male', 'female']),
  address_line_1: z.string().min(1, 'address_line_1 is required'),
  postcode:       z.string().min(1, 'postcode is required'),
  mobile_phone:   z.string().optional(),
  email_address:  z.string().email().optional(),
});

// ============================================================================
// Error Helper
// ============================================================================

function handleError(error, res, next) {
  if (error instanceof z.ZodError) {
    const message = error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      message,
      code: 'VALIDATION_ERROR',
      details: error.issues,
    });
  }

  if (error instanceof DentallyApiError) {
    return res.status(error.statusCode).json({
      success: false,
      error: 'Dentally API Error',
      message: error.message,
      code: error.code || 'DENTALLY_API_ERROR',
    });
  }

  next(error);
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * GET /dentally/availability
 *
 * Fetches available appointment slots from Dentally.
 *
 * @query {string}  practice_id       - Frontly practice identifier
 * @query {string}  start_time        - Search start (ISO 8601)
 * @query {string}  finish_time       - Search end (ISO 8601)
 * @query {number}  [practitioner_id] - Dentally practitioner ID (skip lookup if provided)
 * @query {string}  [practitioner_type] - "dentist" | "hygienist" | "therapist"
 * @query {number}  [duration]        - Minimum slot duration in minutes
 */
router.get('/availability', requireApiKey, async (req, res, next) => {
  try {
    const params = availabilitySchema.parse(req.query);

    const practice = await getPracticeConfig(params.business_identifier);

    let practitionerIds;

    if (params.practitioner_id !== undefined) {
      practitionerIds = [params.practitioner_id];
    } else {
      const allIds = await getPractitionersByRole(
        practice.dentally_api_key,
        practice.user_agent,
        practice.dentally_site_id,
        params.practitioner_type
      );

      if (allIds.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No active ${params.practitioner_type} practitioners found for this practice`,
          code: 'NO_PRACTITIONERS_FOUND',
        });
      }

      // Round robin: pick one practitioner per request to keep availability slots attributable
      const rrKey = `${practice.frontly_practice_id}:${params.practitioner_type}`;
      const pickedId = pickRoundRobin(rrKey, allIds);
      practitionerIds = [pickedId];
      logger.info({ rrKey, allIds, pickedId }, 'Round robin practitioner selected');
    }

    const availability = await getAvailability(practice.dentally_api_key, practice.user_agent, {
      practitionerIds,
      startTime: params.start_time,
      finishTime: params.finish_time,
      duration: params.duration,
    });

    // ── Optional patient lookup by phone ────────────────────────────────────
    let patientId = '';
    if (params.phone) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.phone,
        siteId: practice.dentally_site_id,
      });
      if (results.length > 0) {
        patientId = results[0].id;
        logger.info({ patientId, phone: params.phone }, 'Availability: patient matched by phone');
      } else {
        logger.info({ phone: params.phone }, 'Availability: no patient found for phone');
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    logger.info({ business_identifier: params.business_identifier, practitionerIds }, 'Availability fetched successfully');

    return res.json({ ...availability, practitioner_id: practitionerIds[0], patient_id: patientId });
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * POST /dentally/book
 *
 * Books an appointment in Dentally. Can be booked without a patient_id.
 *
 * @body {string}  business_identifier - Frontly business identifier
 * @body {string}  start_time          - Appointment start (ISO 8601)
 * @body {string}  finish_time         - Appointment end (ISO 8601)
 * @body {number}  practitioner_id     - Dentally practitioner ID
 * @body {string}  reason              - Appointment reason
 * @body {string}  [phone]             - Patient phone number for lookup
 * @body {string}  [name]              - Patient name for lookup (fallback)
 * @body {string}  [state]             - Defaults to "Pending"
 * @body {string}  [notes]
 */
router.post('/book', requireApiKey, async (req, res, next) => {
  try {
    const params = bookSchema.parse(req.body);
    console.log("------------- PHONE : --------", params.phone)
    const practice = await getPracticeConfig(params.business_identifier);

    // ── Patient lookup ──────────────────────────────────────────────────────
    let patientId;

    if (params.phone) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.phone,
        siteId: practice.dentally_site_id,
      });
      if (results.length > 0) {
        patientId = results[0].id;
        logger.info({ patientId, phone: params.phone }, 'Patient matched by phone');
      }
    }

    if (patientId === undefined && params.name) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.name,
        siteId: practice.dentally_site_id,
      });
      if (results.length === 1) {
        patientId = results[0].id;
        logger.info({ patientId, name: params.name }, 'Patient matched by name');
      } else if (results.length > 1) {
        logger.info({ name: params.name, count: results.length }, 'Multiple patients matched by name — booking without patient_id');
      }
    }

    if (patientId === undefined) {
      // No existing patient found — create a placeholder so the appointment is always linked
      logger.info({ phone: params.phone, name: params.name }, 'No patient match — creating placeholder patient');

      const { firstName, lastName } = splitName(params.name);
      const paymentPlanId = await getSiteDefaultPaymentPlanId(practice.dentally_api_key, practice.user_agent, practice.dentally_site_id);

      const newPatient = await registerPatient(practice.dentally_api_key, practice.user_agent, {
        title:        'Mr',
        firstName,
        lastName,
        dateOfBirth:  '1900-01-01',
        gender:       true,
        addressLine1: 'Not provided',
        postcode:     'SW1A 1AA',
        siteId:       practice.dentally_site_id,
        paymentPlanId,
        mobilePhone:  params.phone,
      });

      patientId = newPatient?.patient?.id;
      logger.info({ patientId, firstName, lastName }, 'Placeholder patient created');
    }
    // ────────────────────────────────────────────────────────────────────────

    const appointment = await bookAppointment(practice.dentally_api_key, practice.user_agent, {
      startTime:      params.start_time,
      finishTime:     params.finish_time,
      practitionerId: params.practitioner_id,
      reason:         params.reason,
      patientId,
      state:          params.state,
      notes:          params.notes,
    });

    logger.info(
      { business_identifier: params.business_identifier, practitioner_id: params.practitioner_id, appointment_id: appointment?.appointment?.id, patientId },
      'Appointment booked successfully'
    );

    return res.status(201).json({ ...appointment, patient_id: patientId });
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * POST /dentally/register-patient
 *
 * Creates a new patient in Dentally with minimum required fields.
 * payment_plan_id is resolved automatically from the first active plan.
 * ethnicity is hardcoded to "99" (not stated).
 *
 * @body {string}  practice_id    - Frontly practice identifier
 * @body {string}  title          - Patient title
 * @body {string}  first_name
 * @body {string}  last_name
 * @body {string}  date_of_birth  - YYYY-MM-DD
 * @body {string}  gender         - "male" | "female"
 * @body {string}  address_line_1
 * @body {string}  postcode
 * @body {string}  [mobile_phone]
 * @body {string}  [email_address]
 */
router.post('/register-patient', requireApiKey, async (req, res, next) => {
  try {
    const params = registerPatientSchema.parse(req.body);

    const practice = await getPracticeConfig(params.business_identifier);

    const paymentPlanId = await getSiteDefaultPaymentPlanId(practice.dentally_api_key, practice.user_agent, practice.dentally_site_id);

    const patient = await registerPatient(practice.dentally_api_key, practice.user_agent, {
      title:        params.title,
      firstName:    params.first_name,
      lastName:     params.last_name,
      dateOfBirth:  params.date_of_birth,
      gender:       params.gender === 'male',
      addressLine1: params.address_line_1,
      postcode:     params.postcode,
      siteId:       practice.dentally_site_id,
      paymentPlanId,
      mobilePhone:  params.mobile_phone,
      emailAddress: params.email_address,
    });

    logger.info(
      { business_identifier: params.business_identifier, patient_id: patient?.patient?.id },
      'Patient registered successfully'
    );

    return res.status(201).json(patient);
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * GET /dentally/appointments
 *
 * Lists all appointments for a patient. Patient is resolved by phone or name.
 * Returns 404 if no patient is found (no placeholder creation).
 *
 * @query {string} business_identifier
 * @query {string} [phone]
 * @query {string} [name]
 */
router.get('/appointments', requireApiKey, async (req, res, next) => {
  try {
    const params = listAppointmentsSchema.parse(req.query);

    const practice = await getPracticeConfig(params.business_identifier);

    // ── Patient lookup (no placeholder creation) ────────────────────────────
    let patientId;

    if (params.phone) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.phone,
        siteId: practice.dentally_site_id,
      });
      if (results.length > 0) {
        patientId = results[0].id;
        logger.info({ patientId, phone: params.phone }, 'Patient matched by phone');
      }
    }

    if (patientId === undefined && params.name) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.name,
        siteId: practice.dentally_site_id,
      });
      if (results.length === 1) {
        patientId = results[0].id;
        logger.info({ patientId, name: params.name }, 'Patient matched by name');
      } else if (results.length > 1) {
        logger.info({ name: params.name, count: results.length }, 'Multiple patients matched — cannot determine unique patient');
      }
    }

    if (patientId === undefined) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'No patient found matching the provided phone or name',
        code: 'PATIENT_NOT_FOUND',
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    const appointments = await listPatientAppointments(practice.dentally_api_key, practice.user_agent, {
      patientId,
      siteId: practice.dentally_site_id,
    });

    logger.info({ business_identifier: params.business_identifier, patientId }, 'Patient appointments fetched successfully');

    return res.json(appointments);
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * POST /dentally/reschedule
 *
 * Reschedules an existing appointment by updating its times and optionally its practitioner.
 * Edits the appointment in-place — preserves appointment ID, history, and patient linkage.
 *
 * @body {string} business_identifier
 * @body {number} appointment_id
 * @body {string} start_time          - New start time (ISO 8601)
 * @body {string} finish_time         - New finish time (ISO 8601)
 * @body {number} [practitioner_id]   - New practitioner (optional)
 */
router.post('/reschedule', requireApiKey, async (req, res, next) => {
  try {
    const params = rescheduleSchema.parse(req.body);

    const practice = await getPracticeConfig(params.business_identifier);

    const fields = {
      start_time:  params.start_time,
      finish_time: params.finish_time,
    };
    if (params.practitioner_id !== undefined) fields.practitioner_id = params.practitioner_id;

    const appointment = await updateAppointment(
      practice.dentally_api_key,
      practice.user_agent,
      params.appointment_id,
      fields
    );

    logger.info(
      { business_identifier: params.business_identifier, appointment_id: params.appointment_id },
      'Appointment rescheduled successfully'
    );

    return res.json(appointment);
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * POST /dentally/cancel
 *
 * Cancels an appointment by setting its state to "Cancelled".
 *
 * @body {string} business_identifier
 * @body {number} appointment_id
 */
router.post('/cancel', requireApiKey, async (req, res, next) => {
  try {
    const params = cancelSchema.parse(req.body);

    const practice = await getPracticeConfig(params.business_identifier);

    const appointment = await updateAppointment(
      practice.dentally_api_key,
      practice.user_agent,
      params.appointment_id,
      { state: 'Cancelled' }
    );

    logger.info(
      { business_identifier: params.business_identifier, appointment_id: params.appointment_id },
      'Appointment cancelled successfully'
    );

    return res.json(appointment);
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * POST /dentally/update-patient
 *
 * Updates an existing Dentally patient. Patient is resolved by phone or name.
 * Returns 404 if no patient found. Only provided fields are updated.
 *
 * @body {string}  business_identifier
 * @body {string}  [phone]              - Used for patient lookup
 * @body {string}  [name]               - Fallback lookup (exact 1 match only)
 * @body {string}  [title]
 * @body {string}  [first_name]
 * @body {string}  [last_name]
 * @body {string}  [date_of_birth]      - YYYY-MM-DD
 * @body {string}  [gender]             - "male" | "female"
 * @body {string}  [address_line_1]
 * @body {string}  [address_line_2]
 * @body {string}  [town]
 * @body {string}  [county]
 * @body {string}  [postcode]
 * @body {string}  [mobile_phone]
 * @body {string}  [email_address]
 * @body {string}  [home_phone]
 * @body {string}  [recall_method]      - "Letter" | "SMS" | "Email" | "Phone"
 * @body {boolean} [use_email]
 * @body {boolean} [use_sms]
 */
router.post('/update-patient', requireApiKey, async (req, res, next) => {
  try {
    const params = updatePatientSchema.parse(req.body);

    const practice = await getPracticeConfig(params.business_identifier);

    // ── Patient lookup (no placeholder creation) ────────────────────────────
    let patientId;

    if (params.phone) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.phone,
        siteId: practice.dentally_site_id,
      });
      if (results.length > 0) {
        patientId = results[0].id;
        logger.info({ patientId, phone: params.phone }, 'Patient matched by phone');
      }
    }

    if (patientId === undefined && params.name) {
      const results = await searchPatients(practice.dentally_api_key, practice.user_agent, {
        query: params.name,
        siteId: practice.dentally_site_id,
      });
      if (results.length === 1) {
        patientId = results[0].id;
        logger.info({ patientId, name: params.name }, 'Patient matched by name');
      } else if (results.length > 1) {
        logger.info({ name: params.name, count: results.length }, 'Multiple patients matched — cannot determine unique patient');
      }
    }

    if (patientId === undefined) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'No patient found matching the provided phone or name',
        code: 'PATIENT_NOT_FOUND',
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    // Build update payload — only fields explicitly provided by the caller
    const UPDATE_FIELDS = ['title', 'first_name', 'last_name', 'middle_name', 'date_of_birth',
      'address_line_1', 'address_line_2', 'town', 'county', 'postcode',
      'mobile_phone', 'email_address', 'home_phone', 'recall_method', 'use_email', 'use_sms'];

    const fields = {};
    for (const key of UPDATE_FIELDS) {
      if (params[key] !== undefined) fields[key] = params[key];
    }
    if (params.gender !== undefined) fields.gender = params.gender === 'male';

    const patient = await updatePatient(practice.dentally_api_key, practice.user_agent, patientId, fields);

    logger.info(
      { business_identifier: params.business_identifier, patientId, updatedFields: Object.keys(fields) },
      'Patient updated successfully'
    );

    return res.json(patient);
  } catch (error) {
    return handleError(error, res, next);
  }
});

export default router;
