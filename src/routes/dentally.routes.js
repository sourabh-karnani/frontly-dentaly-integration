import { Router } from 'express';
import { z } from 'zod';
import logger from '../config/logger.js';
import { requireApiKey } from '../middlewares/auth.js';
import {
  getPracticeConfig,
  getPractitionersByRole,
  getAvailability,
  bookAppointment,
  searchPatients,
  getFirstPaymentPlan,
  registerPatient,
  DentallyApiError,
} from '../services/dentally.service.js';

const router = Router();

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
      practitionerIds = await getPractitionersByRole(
        practice.dentally_api_key,
        practice.user_agent,
        practice.dentally_site_id,
        params.practitioner_type
      );

      if (practitionerIds.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No active ${params.practitioner_type} practitioners found for this practice`,
          code: 'NO_PRACTITIONERS_FOUND',
        });
      }
    }

    const availability = await getAvailability(practice.dentally_api_key, practice.user_agent, {
      practitionerIds,
      startTime: params.start_time,
      finishTime: params.finish_time,
      duration: params.duration,
    });

    logger.info({ business_identifier: params.business_identifier, practitionerIds }, 'Availability fetched successfully');

    return res.json(availability);
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
      logger.info({ phone: params.phone, name: params.name }, 'No patient match — booking without patient_id');
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

    return res.status(201).json(appointment);
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

    const paymentPlanId = await getFirstPaymentPlan(practice.dentally_api_key, practice.user_agent);

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

export default router;
