import { Router } from 'express';
import { z } from 'zod';
import logger from '../config/logger.js';
import { requireApiKey } from '../middlewares/auth.js';
import Practice from '../models/Practice.js';
import { DentallyApiError } from '../services/dentally.service.js';

const router = Router();

// ============================================================================
// Validation Schemas
// ============================================================================

const registerBusinessSchema = z.object({
  business_identifier:  z.string().min(1, 'business_identifier is required'),
  frontly_practice_id:  z.string().min(1, 'frontly_practice_id is required'),
  dentally_api_key:     z.string().min(1, 'dentally_api_key is required'),
  dentally_site_id:     z.string().min(1, 'dentally_site_id is required'),
  user_agent:           z.string().min(1, 'user_agent is required'),
  // When omitted the practice has no explicit production/sandbox preference
  // and the service falls back to the legacy PRODUCTION_PRACTICE_IDS allowlist.
  // New per-bot saves from Frontly pass `true` so production keys work by default.
  isProduction:         z.boolean().optional(),
});

// PATCH update — every field optional. Whatever is present is overwritten;
// omitted fields keep their current value. dentally_api_key is sensitive
// and only written when explicitly supplied, so the Frontly admin UI can
// preserve the existing key without ever reading it back.
const updateBusinessSchema = z.object({
  frontly_practice_id:  z.string().min(1).optional(),
  dentally_api_key:     z.string().min(1).optional(),
  dentally_site_id:     z.string().min(1).optional(),
  user_agent:           z.string().min(1).optional(),
  isActive:             z.boolean().optional(),
  isProduction:         z.boolean().optional(),
}).strict();

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
 * POST /business/register
 *
 * Registers a new dental practice in the microservice DB.
 * Creates the Practice document that all other endpoints depend on.
 *
 * @body {string} business_identifier  - Unique identifier for the business (phone, ID, etc.)
 * @body {string} frontly_practice_id  - Frontly's internal practice ID
 * @body {string} dentally_api_key     - Dentally Bearer token for this practice
 * @body {string} dentally_site_id     - Dentally site UUID for this practice
 * @body {string} user_agent           - User-Agent string for Dentally API requests
 */
router.post('/register', requireApiKey, async (req, res, next) => {
  try {
    const params = registerBusinessSchema.parse(req.body);

    const existing = await Practice.findOne({
      $or: [
        { business_identifier: params.business_identifier },
        { frontly_practice_id: params.frontly_practice_id },
      ],
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'A practice with this business_identifier or frontly_practice_id already exists',
        code: 'PRACTICE_ALREADY_EXISTS',
      });
    }

    const practice = await Practice.create({
      business_identifier:  params.business_identifier,
      frontly_practice_id:  params.frontly_practice_id,
      dentally_api_key:     params.dentally_api_key,
      dentally_site_id:     params.dentally_site_id,
      user_agent:           params.user_agent,
      isActive:             true,
      ...(typeof params.isProduction === 'boolean' ? { isProduction: params.isProduction } : {}),
    });

    logger.info(
      { business_identifier: params.business_identifier, frontly_practice_id: params.frontly_practice_id },
      'Business registered successfully'
    );

    return res.status(201).json({
      success: true,
      practice: {
        id:                   practice._id,
        business_identifier:  practice.business_identifier,
        frontly_practice_id:  practice.frontly_practice_id,
        dentally_site_id:     practice.dentally_site_id,
        user_agent:           practice.user_agent,
        isActive:             practice.isActive,
        createdAt:            practice.createdAt,
      },
    });
  } catch (error) {
    return handleError(error, res, next);
  }
});

/**
 * PATCH /business/:business_identifier
 *
 * Updates an existing practice. All body fields are optional; the
 * dentally_api_key is only written when explicitly supplied so the Frontly
 * admin UI never has to round-trip the secret. Returns the updated doc
 * (without dentally_api_key) for confirmation.
 */
router.patch('/:business_identifier', requireApiKey, async (req, res, next) => {
  try {
    const business_identifier = String(req.params.business_identifier || '').trim();
    if (!business_identifier) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'business_identifier path param is required',
        code: 'VALIDATION_ERROR',
      });
    }
    const params = updateBusinessSchema.parse(req.body || {});

    const practice = await Practice.findOne({ business_identifier });
    if (!practice) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Practice not found',
        code: 'PRACTICE_NOT_FOUND',
      });
    }

    if (params.frontly_practice_id !== undefined) practice.frontly_practice_id = params.frontly_practice_id;
    if (params.dentally_api_key   !== undefined) practice.dentally_api_key   = params.dentally_api_key;
    if (params.dentally_site_id   !== undefined) practice.dentally_site_id   = params.dentally_site_id;
    if (params.user_agent         !== undefined) practice.user_agent         = params.user_agent;
    if (params.isActive           !== undefined) practice.isActive           = params.isActive;
    if (params.isProduction       !== undefined) practice.isProduction       = params.isProduction;

    await practice.save();

    logger.info(
      { business_identifier, fields: Object.keys(params) },
      'Business updated successfully'
    );

    return res.status(200).json({
      success: true,
      practice: {
        id:                   practice._id,
        business_identifier:  practice.business_identifier,
        frontly_practice_id:  practice.frontly_practice_id,
        dentally_site_id:     practice.dentally_site_id,
        user_agent:           practice.user_agent,
        isActive:             practice.isActive,
        updatedAt:            practice.updatedAt,
      },
    });
  } catch (error) {
    return handleError(error, res, next);
  }
});

export default router;
