# FlyRank Usage Metering & Billing Engine

Backend service for FlyRank usage metering and billing infrastructure.

## Prerequisites

- Node.js (v18+)
- Docker & Docker Compose

## Quick Start

### 1. PostgreSQL Database Setup

To start the PostgreSQL database container using Docker Compose:

```bash
docker compose up -d
```

To stop the PostgreSQL container:

```bash
docker compose down
```

To view database logs:

```bash
docker compose logs -f postgres
```

### 2. Database Migrations

To apply the database schema to PostgreSQL:

```bash
npm run db:migrate
```

### 3. Database Seeding

To seed initial development data (plans and test tenant):

```bash
npm run db:seed
```

**Development Plans Configuration:**
- **Free Plan**:
  - API Limit: 1,000 requests/month
  - Token Limit: 100,000 tokens/month
  - Price: $0.00 (`0` cents)
- **Pro Plan**:
  - API Limit: 50,000 requests/month
  - Token Limit: 5,000,000 tokens/month
  - Price: $29.00 (`2900` cents)

### 4. Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### 4. Application Setup

Install dependencies:

```bash
npm install
```

Start the application in development mode:

```bash
npm run dev
```

Start the application in production mode:

```bash
npm start
```

## API Endpoints

- `GET /` - Health check / Engine status
- `POST /api/v1/generate` - Generate simulated AI completion & record token usage (Requires `Idempotency-Key` header)

### Example Request (`POST /api/v1/generate`)

```bash
curl -X POST http://localhost:3000/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-key-12345" \
  -d '{
    "input_tokens": 100,
    "cached_tokens": 20,
    "output_tokens": 50,
    "reasoning_tokens": 10
  }'
```

### Example Response (`200 OK`)

```json
{
  "success": true,
  "result": {
    "text": "This is a simulated AI-generated response from FlyRank."
  },
  "usage": {
    "input_tokens": 100,
    "cached_tokens": 20,
    "output_tokens": 50,
    "reasoning_tokens": 10,
    "total_tokens": 180
  }
}
```

### Quota Exceeded Response (`429 Too Many Requests`)

```json
{
  "error": "Too Many Requests",
  "quota_type": "API_CALLS",
  "message": "Monthly API call limit exceeded. Limit: 1000, Current: 1000, Requested: 1."
}
```
