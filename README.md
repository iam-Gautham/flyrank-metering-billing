# FlyRank Usage Metering & Billing Engine

Backend service for FlyRank usage metering and billing infrastructure.

```text
+-----------------------------------------------------------------------------------+
|                                 CLIENT APPLICATIONS                               |
+-----------------------------------------------------------------------------------+
        |                                       |                              |
 (POST /generate)                       (GET /usage)                    (POST /checkout)
 [Idempotency-Key]                      [Billing Period]                [Plan Upgrades]
 [Auth: Bearer / x-tenant-id]           [Auth: Bearer / x-tenant-id]   [Auth: Bearer / x-tenant-id]
        |                                       |                              |
        v                                       v                              v
+-----------------------------------------------------------------------------------+
|                             EXPRESS API / ROUTER LAYER                            |
+-----------------------------------------------------------------------------------+
        |                                       |                              |
        v                                       v                              v
+-----------------------------------------------------------------------------------+
|                       authenticateTenant Middleware (Auth & Tenant Context)       |
+-----------------------------------------------------------------------------------+
        |                                       |                              |
        v                                       v                              v
+-----------------------+               +----------------------+      +----------------------+
|  generateController   |               |   tenantUsageService |      |   checkoutService    |
+-----------------------+               +----------------------+      +----------------------+
        |                                       |                              |
        v                                       v                              v
+-----------------------+               +----------------------+      +----------------------+
|     quotaService      |               |     pricingService   |      |   webhookService     |
+-----------------------+               +----------------------+      +----------------------+
        |                                       |                              |
        +---------------------------+-----------+                              |
                                    |                                          v
                                    v                                 +----------------------+
                            +---------------+                         | FakePaymentProvider  |
                            | PostgreSQL 16 |                         | (Local ₹0 / $0 Mode) |
                            +---------------+                         +----------------------+
                            | - tenants     |                                  ^
                            | - plans       |                                  |
                            | - subscriptions                                  |
                            | - usage_events (API_CALL + AI_TOKENS)            |
                            | - webhook_events                                 |
                            +--------------------------------------------------+
```

## Security & Authentication Model (Phase 5.4)

### 1. Authentication Middleware (`authenticateTenant`)
All protected API endpoints require authenticated tenant context:
- Accepts `Authorization: Bearer <token_or_tenant_id>`, `X-API-Key`, or `x-tenant-id` headers.
- Authenticates credentials against PostgreSQL database (`SELECT id, name FROM tenants WHERE id::text = $1 OR name = $1`).
- Returns **HTTP 401 Unauthorized** for invalid, expired, or non-existent tenant identities.
- Unauthenticated requests in local development fall back to the default Demo Tenant.

### 2. Tenant Authorization & Cross-Tenant Security Invariants
- `req.tenant` attached by `authenticateTenant` is the **authoritative tenant identity** across all controllers and services.
- **Cross-Tenant Isolation**: Requesting another tenant's invoice ID (`GET /api/v1/invoices/:id`) returns **HTTP 404 Not Found** without leaking whether the resource exists.
- **Idempotency Security**: Idempotency keys are evaluated against `(tenant_id, idempotency_key)` in PostgreSQL, ensuring identical keys used by different tenants never collide or leak cached responses.

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

**AI Token Pricing Rates (Development Rates):**
- **Input Tokens**: $3.00 per 1M tokens (300 nano-cents / token)
- **Cached Input Tokens**: $0.75 per 1M tokens (75 nano-cents / token — 75% discount)
- **Output Tokens**: $15.00 per 1M tokens (1,500 nano-cents / token)
- **Reasoning Tokens**: $30.00 per 1M tokens (3,000 nano-cents / token)

> **Monetary Arithmetic Note:** All calculations use pure integer nano-cents arithmetic ($1 \text{ USD cent} = 1,000,000 \text{ nano-cents}$) rounded to the nearest cent without floating-point math. Stored in `usage_events.cost_cents`.

### 4. Payment Provider Architecture (Zero-Cost Local Mode)

Development uses a local **Fake Payment Provider** (`PAYMENT_PROVIDER=fake`):
- **Cost**: ₹0 / $0 (100% free local development).
- **Network & Account**: Makes zero external network requests, requires no payment provider account, and requires no API keys or credit cards.
- **Provider Abstraction**: All billing services depend on `src/services/paymentProvider.js`, allowing real production payment gateways to be plugged in later behind the same interface.

#### Mapping Fake Provider to Production Payment Gateway (Stripe Mapping)

| Fake Provider Method | Real Stripe Gateway Mapping | Description |
| :--- | :--- | :--- |
| `createCheckoutSession(...)` | `stripe.checkout.sessions.create({...})` | Generates customer ID and hosted checkout session URL. |
| `getSubscription(id)` | `stripe.subscriptions.retrieve(id)` | Retrieves authoritative subscription state and billing period bounds. |
| `cancelSubscription(id)` | `stripe.subscriptions.cancel(id)` | Cancels active subscription at period end or immediately. |
| `processEvent(event)` | `stripe.webhooks.constructEvent(...)` | Verifies Stripe cryptographic signature (`stripe-signature` header). |

### 5. Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### 6. Application Setup & Testing

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

Run full automated test suite:

```bash
npm test
```

## API Endpoints

- `GET /` - Health check / Engine status
- `POST /api/v1/generate` - Generate simulated AI completion & record token usage (Requires `Idempotency-Key` & Tenant Auth)
- `GET /api/v1/usage` - Get current billing period usage summary, plan limits, and remaining quotas (Requires Tenant Auth)
- `GET /api/v1/subscription` - Get tenant subscription details and status (Requires Tenant Auth)
- `POST /api/v1/subscription/checkout` - Simulated zero-cost plan checkout (Free / Pro) (Requires Tenant Auth)
- `POST /api/v1/subscription/cancel` - Cancel tenant active subscription (Requires Tenant Auth)
- `GET /api/v1/invoices/current` - Itemized current monthly billing invoice statement (Requires Tenant Auth)
- `GET /api/v1/invoices` - List historical monthly billing invoices (Requires Tenant Auth)
- `GET /api/v1/invoices/:id` - Fetch invoice statement by ID (Requires Tenant Auth; Cross-tenant returns 404)
- `POST /api/v1/webhooks/payment` - Process simulated payment-provider subscription lifecycle webhooks

### Example Request (`GET /api/v1/subscription`)

```bash
curl -H "Authorization: Bearer Demo Tenant" http://localhost:3000/api/v1/subscription
```

### Example Response (`200 OK`)

```json
{
  "tenant": {
    "id": "32e8849a-6f0a-4639-9c57-30da0f98ca6f",
    "name": "Demo Tenant"
  },
  "subscription": {
    "id": "99cd2a2d-8877-489f-837b-99b86d123006",
    "provider": "fake",
    "customer_id": "fake_cust_32e8849a",
    "subscription_id": "fake_sub_df4bd0e997c48984",
    "plan": {
      "name": "Pro",
      "price_cents": 2900,
      "monthly_api_limit": 50000,
      "monthly_token_limit": 5000000
    },
    "status": "active",
    "current_period_start": "2026-07-31T18:30:00.000Z",
    "current_period_end": "2026-08-31T18:29:59.999Z"
  }
}
```

### Example Request (`POST /api/v1/generate`)

```bash
curl -X POST http://localhost:3000/api/v1/generate \
  -H "Authorization: Bearer Demo Tenant" \
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
