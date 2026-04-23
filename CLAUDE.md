# frontly-dentally — Claude Context

## What this service is

A Node.js/Express microservice that sits between the Frontly backend and the Dentally practice management API. The Frontly backend calls this service; this service handles all Dentally auth and API interaction.

Built as part of Frontly (Phase 1) — an AI agent that books dental appointments on behalf of patients via conversation.

## Tech stack

- **Runtime:** Node.js with ES modules (`"type": "module"`)
- **Framework:** Express v5
- **Validation:** Zod
- **DB:** MongoDB via Mongoose
- **Logging:** Pino + pino-pretty (dev)
- **Dentally API base URL:** `https://api.sandbox.dentally.co` (sandbox) — change to `https://api.dentally.co` for production

## Project structure

```
src/
  app.js                         Express app setup, middleware, route mounting
  server.js                      MongoDB connect + HTTP server start
  config/
    env.js                       Env var loading and validation
    logger.js                    Pino logger (service name: frontly-dentally)
    db.js                        Mongoose connect
  middlewares/
    auth.js                      x-api-key header check
    errorHandler.js              Global error handler
    requestPayloadLogger.js      Logs full request bodies when LOG_FULL_PAYLOADS=true
  models/
    Practice.js                  MongoDB model — one document per dental practice client
  routes/
    business.routes.js           POST /business/register
    dentally.routes.js           GET /dentally/availability, POST /dentally/book, POST /dentally/register-patient
  services/
    dentally.service.js          All Dentally API calls + DB config lookup
```

## Database — Practice model

One document per dental practice (client). All Dentally endpoints look up credentials from this collection using `business_identifier`.

```js
{
  business_identifier:  String  // unique — can be phone number or any ID sent by Frontly backend
  frontly_practice_id:  String  // Frontly's internal practice ID
  dentally_api_key:     String  // Bearer token for Dentally API
  dentally_site_id:     String  // Dentally site UUID for this practice
  user_agent:           String  // User-Agent header sent to Dentally (e.g. "Frontly/1.0")
  isActive:             Boolean // soft disable without deleting
}
```

## Auth model

Two layers:
1. **Inbound (Frontly backend → this service):** `x-api-key` header checked against `API_KEY` env var
2. **Outbound (this service → Dentally):** Per-practice `Authorization: Bearer <dentally_api_key>` + `User-Agent` header, credentials fetched from MongoDB by `business_identifier`

## Endpoints summary

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/business/register` | Register a new dental practice in MongoDB |
| GET | `/dentally/availability` | Get available appointment slots |
| POST | `/dentally/book` | Book an appointment (with optional patient lookup) |
| POST | `/dentally/register-patient` | Create a new patient in Dentally |

## Key design decisions

**`business_identifier` as the lookup key**
The Frontly backend never passes Dentally credentials. It only passes `business_identifier` (a phone number or any unique string). This service resolves all credentials internally from MongoDB.

**Practitioner type resolution**
`GET /dentally/availability` accepts either a direct `practitioner_id` (integer) or a `practitioner_type` string (`"dentist"` | `"hygienist"` | `"therapist"`). When a type is given, the service calls `GET /v1/practitioners?site_id=...`, filters by `active === true && user.role.toLowerCase() === practitioner_type`, and extracts the IDs. No caching — fresh lookup each time (practitioners don't change often, caching is a future optimisation).

**Book appointment — patient lookup flow**
The `/book` endpoint does not accept a `patient_id` directly. Instead it accepts optional `phone` and `name`:
1. Search by `phone` → first match wins
2. If no phone match, search by `name` → only used if exactly 1 result (multiple = ambiguous)
3. If no match or no params → book without patient (placeholder booking)

This supports the Sentinel flow: book first, register patient separately, then update appointment to link them (endpoint 4 — not yet implemented).

**Patient registration defaults**
`POST /dentally/register-patient` hardcodes `ethnicity: "99"` (not stated). `payment_plan_id` is resolved by calling `GET /v1/payment_plans?active=true` and using the first result's ID. Neither is passed by the caller.

**`gender` normalisation**
Dentally uses a boolean for gender (`true` = male, `false` = female). This service accepts `"male"` | `"female"` strings and converts internally.

## Dentally API notes

- All requests need `Authorization: Bearer <token>` and `User-Agent: <string>` headers
- Request bodies must be wrapped in a resource object: `{ "appointment": { ... } }`, `{ "patient": { ... } }`
- Sandbox base URL: `https://api.sandbox.dentally.co`
- `GET /v1/appointments/availability` — max 20 results per page, `practitioner_ids[]` is a repeated query param
- `GET /v1/patients?query=...` — searches name, phone, postcode, DOB, email
- Appointment `state` valid values: `Pending`, `Confirmed`, `Arrived`, `In surgery`, `Completed`, `Cancelled`, `Did not attend`
- Appointment `reason` valid values: `Exam`, `Scale & Polish`, `Exam + Scale & Polish`, `Continuing Treatment`, `Emergency`, `Review`, `Other`

## Not yet implemented (On hold due to some blockers)

- `PATCH /dentally/update-appointment` — update an appointment to link a `patient_id` after registration
- `POST /dentally/reschedule` — reschedule an existing appointment
- `POST /dentally/cancel` — cancel an existing appointment

## Environment variables

```
NODE_ENV          development | production
PORT              default 3001
API_KEY           Frontly internal API key (required)
MONGO_URI         MongoDB connection string (required)
LOG_FULL_PAYLOADS true | false — logs full Dentally request/response bodies (default false)
```

## Adding a new endpoint — checklist

1. Add service function(s) to `dentally.service.js` using `dentallyFetch`
2. Add Zod schema to the relevant routes file
3. Add route handler — validate → `getPracticeConfig(business_identifier)` → service call → return
4. Use the existing `handleError` helper for ZodError + DentallyApiError
5. Add a startup log line to `server.js`
6. Document in `API.md`
