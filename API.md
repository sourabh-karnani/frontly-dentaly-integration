# frontly-dentally API Reference

A Node.js/Express microservice that wraps the [Dentally API](https://developer.dentally.co) for use by the Frontly backend.

## Base URL

```
http://localhost:3001   (development)
```

## Authentication

Every request must include the internal Frontly API key as a header:

```
x-api-key: <API_KEY>
```

The `API_KEY` value is set in the `.env` file. Requests without it return `401`.

---

## Endpoints

### Health Check

```
GET /health
```

No auth required.

**Response `200`**
```json
{
  "status": "ok",
  "service": "frontly-dentally",
  "timestamp": "2026-04-23T10:00:00.000Z"
}
```

---

### Register Business

```
POST /business/register
```

Creates a new dental practice entry in the microservice DB. Must be done before any Dentally endpoints can be used for that practice.

**Headers**
```
x-api-key: <API_KEY>
Content-Type: application/json
```

**Request Body**
| Field | Type | Required | Description |
|---|---|---|---|
| `business_identifier` | string | ✅ | Unique identifier for the business — can be a phone number, UUID, or any string |
| `frontly_practice_id` | string | ✅ | Frontly's internal practice ID |
| `dentally_api_key` | string | ✅ | Dentally Bearer token for this practice |
| `dentally_site_id` | string | ✅ | Dentally site UUID for this practice |
| `user_agent` | string | ✅ | User-Agent string sent to Dentally API (e.g. `"Frontly/1.0"`) |

**Example**
```bash
curl -X POST "http://localhost:3001/business/register" \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "business_identifier": "+447911123456",
    "frontly_practice_id": "practice_001",
    "dentally_api_key": "your-dentally-bearer-token",
    "dentally_site_id": "e1d854af-15db-4482-8e29-39e74a6c7f75",
    "user_agent": "Frontly/1.0"
  }'
```

**Response `201`**
```json
{
  "success": true,
  "practice": {
    "id": "665f1a2b3c4d5e6f7a8b9c0d",
    "business_identifier": "+447911123456",
    "frontly_practice_id": "practice_001",
    "dentally_site_id": "e1d854af-15db-4482-8e29-39e74a6c7f75",
    "user_agent": "Frontly/1.0",
    "isActive": true,
    "createdAt": "2026-04-23T10:00:00.000Z"
  }
}
```

**Response `409`** — practice already exists
```json
{
  "success": false,
  "error": "Conflict",
  "message": "A practice with this business_identifier or frontly_practice_id already exists",
  "code": "PRACTICE_ALREADY_EXISTS"
}
```

---

### Get Availability

```
GET /dentally/availability
```

Fetches available appointment slots from Dentally for a given practitioner and time window.

**Headers**
```
x-api-key: <API_KEY>
```

**Query Parameters**
| Field | Type | Required | Description |
|---|---|---|---|
| `business_identifier` | string | ✅ | Identifies the practice in the microservice DB |
| `start_time` | string (ISO 8601) | ✅ | Start of the search window. Must be in the future |
| `finish_time` | string (ISO 8601) | ✅ | End of the search window. Must be after `start_time` |
| `practitioner_id` | integer | ✅ or `practitioner_type` | Dentally practitioner ID. If provided, skips practitioner lookup |
| `practitioner_type` | string | ✅ or `practitioner_id` | `"dentist"` \| `"hygienist"` \| `"therapist"`. Resolved to IDs via Dentally API |
| `duration` | integer | ❌ | Minimum slot duration in minutes. Defaults to practice minimum (usually 5 min) |

> Either `practitioner_id` or `practitioner_type` must be provided, not neither.

**Example — by type**
```bash
curl -X GET "http://localhost:3001/dentally/availability?business_identifier=%2B447911123456&practitioner_type=dentist&start_time=2026-05-01T09%3A00%3A00Z&finish_time=2026-05-07T17%3A00%3A00Z&duration=30" \
  -H "x-api-key: your-api-key"
```

**Example — by ID**
```bash
curl -X GET "http://localhost:3001/dentally/availability?business_identifier=%2B447911123456&practitioner_id=1&start_time=2026-05-01T09%3A00%3A00Z&finish_time=2026-05-07T17%3A00%3A00Z" \
  -H "x-api-key: your-api-key"
```

**Response `200`**
```json
{
  "availability": [
    {
      "start_time": "2026-05-01T09:00:00.000+00:00",
      "finish_time": "2026-05-01T11:20:00.000+00:00",
      "available_duration": 140
    }
  ],
  "meta": {
    "page": 1
  }
}
```

**Response `404`** — no practitioners found for type
```json
{
  "success": false,
  "error": "Not Found",
  "message": "No active dentist practitioners found for this practice",
  "code": "NO_PRACTITIONERS_FOUND"
}
```

---

### Book Appointment

```
POST /dentally/book
```

Books an appointment in Dentally. Optionally resolves a patient by phone or name and links them. Can be booked without a patient (placeholder booking).

**Patient lookup logic:**
1. If `phone` provided → search Dentally by phone → first match wins
2. If no phone match and `name` provided → search by name → only used if exactly **1** result (multiple = ambiguous, skip)
3. If no match or neither provided → book without `patient_id`

**Headers**
```
x-api-key: <API_KEY>
Content-Type: application/json
```

**Request Body**
| Field | Type | Required | Description |
|---|---|---|---|
| `business_identifier` | string | ✅ | Identifies the practice |
| `start_time` | string (ISO 8601) | ✅ | Appointment start |
| `finish_time` | string (ISO 8601) | ✅ | Appointment end |
| `practitioner_id` | integer | ✅ | Dentally practitioner ID |
| `reason` | string | ✅ | `"Exam"` \| `"Scale & Polish"` \| `"Exam + Scale & Polish"` \| `"Continuing Treatment"` \| `"Emergency"` \| `"Review"` \| `"Other"` |
| `phone` | string | ❌ | Patient phone for lookup |
| `name` | string | ❌ | Patient name for lookup (fallback if phone not matched) |
| `state` | string | ❌ | `"Pending"` \| `"Confirmed"` \| ... Defaults to `"Pending"` |
| `notes` | string | ❌ | Appointment notes |

**Example**
```bash
curl -X POST "http://localhost:3001/dentally/book" \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "business_identifier": "+447911123456",
    "start_time": "2026-05-02T09:00:00Z",
    "finish_time": "2026-05-02T09:30:00Z",
    "practitioner_id": 1,
    "reason": "Exam",
    "phone": "07123456789",
    "name": "John Smith"
  }'
```

**Response `201`**
```json
{
  "appointment": {
    "id": 14493,
    "uuid": "f7b1b1b0-0b1b-4b1b-8b1b-2a2b5b6b1e1c",
    "start_time": "2026-05-02T09:00:00.000+00:00",
    "finish_time": "2026-05-02T09:30:00.000+00:00",
    "practitioner_id": 1,
    "patient_id": 1001,
    "state": "Pending",
    "reason": "Exam",
    "duration": 30
  }
}
```

---

### Register Patient

```
POST /dentally/register-patient
```

Creates a new patient record in Dentally. `payment_plan_id` is resolved automatically from the first active payment plan. `ethnicity` is hardcoded to `"99"` (not stated).

**Headers**
```
x-api-key: <API_KEY>
Content-Type: application/json
```

**Request Body**
| Field | Type | Required | Description |
|---|---|---|---|
| `business_identifier` | string | ✅ | Identifies the practice |
| `title` | string | ✅ | `"Mr"` \| `"Mrs"` \| `"Miss"` \| `"Ms"` \| `"Dr"` \| `"Master"` \| `"Prof"` \| `"Hon"` \| `"Rev"` \| `"Sir"` \| `"Lady"` \| `"Lord"` \| `"Earl"` \| `"Judge"` \| `"Dame"` |
| `first_name` | string | ✅ | |
| `last_name` | string | ✅ | |
| `date_of_birth` | string | ✅ | Format: `YYYY-MM-DD` |
| `gender` | string | ✅ | `"male"` \| `"female"` |
| `address_line_1` | string | ✅ | |
| `postcode` | string | ✅ | |
| `mobile_phone` | string | ❌ | |
| `email_address` | string | ❌ | Must be valid email format |

**Example**
```bash
curl -X POST "http://localhost:3001/dentally/register-patient" \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "business_identifier": "+447911123456",
    "title": "Mr",
    "first_name": "John",
    "last_name": "Smith",
    "date_of_birth": "1990-05-15",
    "gender": "male",
    "address_line_1": "21 Oak Avenue",
    "postcode": "W1A 1AA",
    "mobile_phone": "07123456789",
    "email_address": "john.smith@email.com"
  }'
```

**Response `201`**
```json
{
  "patient": {
    "id": 3,
    "first_name": "John",
    "last_name": "Smith",
    "date_of_birth": "1990-05-15",
    "email_address": "john.smith@email.com",
    "mobile_phone": "07123456789",
    "site_id": "e1d854af-15db-4482-8e29-39e74a6c7f75",
    "payment_plan_id": 139780,
    "active": true
  }
}
```

---

## Common Error Responses

**`400` Validation Error**
```json
{
  "success": false,
  "error": "Validation Error",
  "message": "start_time: start_time is required",
  "code": "VALIDATION_ERROR",
  "details": [...]
}
```

**`401` Unauthorized**
```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "API key is required",
  "code": "MISSING_API_KEY"
}
```

**`404` Practice Not Found**
```json
{
  "success": false,
  "error": "Dentally API Error",
  "message": "Practice not found for identifier: +447911123456",
  "code": "PRACTICE_NOT_FOUND"
}
```

**`500` Internal Server Error**
```json
{
  "success": false,
  "error": "Internal Server Error",
  "message": "An unexpected error occurred",
  "code": "SERVER_ERROR"
}
```

---

## Local Setup

```bash
# Install dependencies
npm install

# Copy env and fill in values
cp .env.example .env

# Start in development mode
npm run dev
```

**.env values**
```
NODE_ENV=development
PORT=3001
API_KEY=your-frontly-internal-api-key
MONGO_URI=mongodb://localhost:27017/frontly-dentally
LOG_FULL_PAYLOADS=false
```

**Register your first practice**
```js
// MongoDB shell
db.practices.insertOne({
  business_identifier: "+447911123456",
  frontly_practice_id: "practice_001",
  dentally_api_key: "your-dentally-bearer-token",
  dentally_site_id: "e1d854af-15db-4482-8e29-39e74a6c7f75",
  user_agent: "Frontly/1.0",
  isActive: true
})
```

Or use the API:
```bash
curl -X POST "http://localhost:3001/business/register" \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "business_identifier": "+447911123456",
    "frontly_practice_id": "practice_001",
    "dentally_api_key": "your-dentally-bearer-token",
    "dentally_site_id": "e1d854af-15db-4482-8e29-39e74a6c7f75",
    "user_agent": "Frontly/1.0"
  }'
```
