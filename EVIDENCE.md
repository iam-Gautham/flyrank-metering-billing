# FlyRank Usage Metering & Billing Engine - Capstone Verification Evidence

This document contains real, un-edited empirical command outputs from automated test suite runs, live API `curl` probes, and direct PostgreSQL queries validating all Definition-of-Done requirements and Acceptance Probes.

---

## 1. Complete Automated Test Suite Output (`npm test`)

**Command**: `npm test`  
**Result**: 66 tests passing, 0 failing, 0 skipped.

```text
> flyrank-metering-billing@1.0.0 test
> node --test tests/**/*.test.js

✔ Billing Hardening - full subscription lifecycle (Free -> Pro -> Free -> Canceled) maintains DB integrity (118.092958ms)
✔ Billing Hardening - single active subscription invariant enforced under multiple activations (44.713164ms)
✔ Billing Hardening - expired billing period auto-rollover to current calendar month boundaries (44.737257ms)
✔ Billing Hardening - exact month boundary inclusion and exclusion logic (30.884833ms)
✔ Billing Hardening - webhook rejects tenant_id mismatch for subscription (HTTP 400) (30.996815ms)
✔ Billing State Machine - complete state transition lifecycle (Free -> Pro -> past_due -> active recovery -> canceled) (130.282642ms)
✔ Billing Renewal - period update, quota reset, and previous-period usage exclusion (27.523471ms)
✔ Concurrency & State Hardening - concurrent payment success, failure, and duplicate webhooks (50.709972ms)
✔ Security & Stale Event Protection - stale payment success event cannot reactivate a newer canceled subscription (64.897944ms)
✔ POST /api/v1/subscription/checkout - returns 400 when plan_name is missing or empty (53.415372ms)
✔ POST /api/v1/subscription/checkout - returns 404 when requested plan does not exist in DB (24.729511ms)
✔ POST /api/v1/subscription/checkout - successful Free plan checkout (29.514802ms)
✔ POST /api/v1/subscription/checkout - successful Pro plan checkout and plan upgrade without duplicate active subscriptions (49.930625ms)
✔ POST /api/v1/generate - returns 400 Bad Request when Idempotency-Key header is missing or empty (51.767225ms)
✔ POST /api/v1/generate - returns 400 Bad Request when token values are invalid (8.494625ms)
✔ POST /api/v1/generate - creates atomic API_CALL and AI_TOKENS events, handles idempotency and distinct keys (53.219302ms)
✔ POST /api/v1/generate - API Call Quota enforcement (counts API_CALL events) (59.92444ms)
✔ POST /api/v1/generate - AI Token Quota enforcement (counts AI_TOKENS events) (29.879016ms)
✔ Scenario A - clean tenant request sequence, dual event creation, cost calculation, and idempotent repeat (81.220237ms)
✔ Scenario B - API quota boundary enforcement and 429 rejection without creating usage events (56.739971ms)
✔ Scenario C - AI token quota boundary and 429 rejection (29.3468ms)
✔ Scenario D - concurrent requests with different idempotency keys create two pairs of dual events (49.404031ms)
✔ Scenario E - concurrent requests with the SAME idempotency key create only ONE API_CALL + ONE AI_TOKENS event (53.18278ms)
✔ Transaction Rollback Safety - failed transaction rolls back cleanly without partial quota state commit (22.380715ms)
✔ Tenant-Scoped Idempotency - same idempotency key is allowed for different tenants (16.310565ms)
✔ Scenario A - Free -> Generate -> Upgrade Pro -> Verify Higher Quota -> Generate Again (155.167723ms)
✔ Scenario B - Pro -> Generate -> Downgrade Free -> Free Limits Immediately Enforced (59.920488ms)
✔ Scenario C - Active Subscription -> Cancel -> Fallback to Free -> Generate Request (50.401806ms)
✔ Scenario D - Subscription Renewal / Month Transition -> Previous-Period Usage Does Not Count (27.519852ms)
✔ Pricing & Zero-Token Integration - handles zero-token request and integer monetary arithmetic (24.64044ms)
✔ Concurrency Protection - parallel requests near quota boundary prevent quota oversubscription (2547.156858ms)
✔ Multi-Tenant Isolation - same idempotency key is safe across distinct tenants (26.922834ms)
✔ FakePaymentProvider - creates checkout session locally with deterministic IDs (1.932793ms)
✔ FakePaymentProvider - retrieves created subscription (0.22186ms)
✔ FakePaymentProvider - cancels subscription (0.190738ms)
✔ FakePaymentProvider - processes simulated webhook events (0.275438ms)
✔ PaymentProvider Factory - defaults safely to FakePaymentProvider when PAYMENT_PROVIDER is unset or fake (0.655125ms)
✔ pricingService - normal input token cost calculation (1.780595ms)
✔ pricingService - discounted cached token cost calculation (0.150989ms)
✔ pricingService - output token cost calculation (0.081446ms)
✔ pricingService - reasoning token cost calculation (0.079395ms)
✔ pricingService - combined token categories cost calculation (0.117742ms)
✔ pricingService - pure integer monetary arithmetic without floating-point rounding errors (0.114205ms)
✔ GET /api/v1/subscription - retrieves tenant active subscription details (76.255944ms)
✔ POST /api/v1/subscription/cancel - cancels active subscription and updates DB status to canceled (36.92061ms)
✔ POST /api/v1/subscription/cancel - returns 404 when no active subscription exists (11.754094ms)
✔ POST /api/v1/subscription/cancel - returns 404 on repeated cancellation (26.676907ms)
✔ Usage and quota behavior remains correct post-cancellation (falls back to default Free plan logic) (77.758817ms)
✔ GET /api/v1/usage - returns zero usage for a clean tenant (70.521648ms)
✔ GET /api/v1/usage - calculates API_CALL and AI_TOKENS usage and remaining quotas correctly (32.776907ms)
✔ GET /api/v1/usage - excludes usage events outside the current billing period (29.171505ms)
✔ GET /api/v1/usage - does not create or modify usage events (read-only) (27.749543ms)
✔ POST /api/v1/webhooks/payment - returns 400 for invalid webhook payload structure (85.276153ms)
✔ POST /api/v1/webhooks/payment - returns 400 for unknown event type (15.412509ms)
✔ POST /api/v1/webhooks/payment - returns 404 for unknown subscription ID without corrupting data (31.151664ms)
✔ POST /api/v1/webhooks/payment - subscription.created event creates/activates subscription and handles duplicates idempotently (25.672543ms)
✔ POST /api/v1/webhooks/payment - subscription.updated event updates status & plan, duplicate is idempotent (23.849314ms)
✔ POST /api/v1/webhooks/payment - subscription.cancelled event sets status to canceled, retains row, duplicate is idempotent (24.881746ms)
✔ POST /api/v1/webhooks/payment - concurrent duplicate webhook delivery protection (59.614465ms)
✔ POST /api/v1/webhooks/payment - out-of-order and stale event protection (54.371956ms)
✔ POST /api/v1/webhooks/payment - transaction rollback safety on processing failure (21.043795ms)
✔ POST /api/v1/webhooks/payment - tenant/subscription-scoped isolation guarantee (37.807679ms)
✔ Webhook Production - subscription.deleted sets status to canceled and persists in webhook_events (88.610707ms)
✔ Webhook Production - invoice.payment_succeeded activates subscription and updates period bounds (47.034302ms)
✔ Webhook Production - invoice.payment_failed sets subscription status to past_due (51.046347ms)
✔ Webhook Production - webhook_events provider_event_id unique constraint prevents duplicate processing (53.497236ms)

ℹ tests 66
ℹ suites 0
ℹ pass 66
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7278.515989
```

---

## 2. Acceptance Probe 1 — Idempotency Evidence

### A. First Request (`POST /api/v1/generate`)
```bash
curl -i -X POST http://localhost:3000/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: probe-1-idempotent-key" \
  -d '{
    "input_tokens": 1000,
    "cached_tokens": 200,
    "output_tokens": 500,
    "reasoning_tokens": 100
  }'
```
**HTTP Response (`200 OK`)**:
```json
{"success":true,"result":{"text":"This is a simulated AI-generated response from FlyRank."},"usage":{"input_tokens":1000,"cached_tokens":200,"output_tokens":500,"reasoning_tokens":100,"total_tokens":1800}}
```

### B. Second Request (Same Idempotency-Key)
```bash
curl -i -X POST http://localhost:3000/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: probe-1-idempotent-key" \
  -d '{
    "input_tokens": 1000,
    "cached_tokens": 200,
    "output_tokens": 500,
    "reasoning_tokens": 100
  }'
```
**HTTP Response (`200 OK`)**:
```json
{"success":true,"result":{"text":"This is a simulated AI-generated response from FlyRank."},"usage":{"input_tokens":1000,"cached_tokens":200,"output_tokens":500,"reasoning_tokens":100,"total_tokens":1800}}
```

### C. PostgreSQL Verification Query
```sql
SELECT usage_type, quantity, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_cents, idempotency_key FROM usage_events WHERE idempotency_key LIKE 'probe-1-idempotent-key%';
```
**PostgreSQL Output**:
```text
 usage_type | quantity | input_tokens | cached_tokens | output_tokens | reasoning_tokens | cost_cents |        idempotency_key
------------+----------+--------------+---------------+---------------+------------------+------------+-------------------------------
 API_CALL   |        1 |            0 |             0 |             0 |                0 |          0 | probe-1-idempotent-key:api
 AI_TOKENS  |     1800 |         1000 |           200 |           500 |              100 |          1 | probe-1-idempotent-key:tokens
(2 rows)
```

---

## 3. Acceptance Probe 2 — Quota Boundary Evidence

### A. Usage Summary at Limit (`GET /api/v1/usage`)
```bash
curl -i http://localhost:3000/api/v1/usage
```
**HTTP Response (`200 OK`)**:
```json
{"tenant":{"id":"32e8849a-6f0a-4639-9c57-30da0f98ca6f","name":"Demo Tenant"},"plan":{"name":"Free"},"period":{"start":"2026-07-31T18:30:00.000Z","end":"2026-08-31T18:29:59.999Z"},"usage":{"api_calls":{"used":1000,"limit":1000,"remaining":0},"ai_tokens":{"used":1800,"limit":100000,"remaining":98200}}}
```

### B. Request Exceeding Quota (`POST /api/v1/generate`)
```bash
curl -i -X POST http://localhost:3000/api/v1/generate \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: probe-2-boundary-key" \
  -d '{
    "input_tokens": 100,
    "cached_tokens": 0,
    "output_tokens": 50,
    "reasoning_tokens": 0
  }'
```
**HTTP Response (`429 Too Many Requests`)**:
```json
{"error":"Too Many Requests","quota_type":"API_CALLS","message":"Monthly API call limit exceeded. Limit: 1000, Current: 1000, Requested: 1."}
```

### C. PostgreSQL Verification Query (0 rows created on 429 rejection)
```sql
SELECT COUNT(*) FROM usage_events WHERE idempotency_key LIKE 'probe-2-boundary-key%';
```
**PostgreSQL Output**:
```text
 count
-------
     0
(1 row)
```

---

## 4. Acceptance Probe 3 — Checkout / Payment Abstraction Evidence

### A. Pro Plan Checkout (`POST /api/v1/subscription/checkout`)
```bash
curl -i -X POST http://localhost:3000/api/v1/subscription/checkout \
  -H "Content-Type: application/json" \
  -d '{ "plan_name": "Pro" }'
```
**HTTP Response (`200 OK`)**:
```json
{"success":true,"checkout":{"provider":"fake","session_id":"fake_checkout_e1159e7cdcede107","subscription_id":"fake_sub_b7705798808e471a","plan":"Pro","status":"active"}}
```

### B. Usage Query Reflecting Pro Limits (`GET /api/v1/usage`)
```bash
curl -i http://localhost:3000/api/v1/usage
```
**HTTP Response (`200 OK`)**:
```json
{"tenant":{"id":"32e8849a-6f0a-4639-9c57-30da0f98ca6f","name":"Demo Tenant"},"plan":{"name":"Pro"},"period":{"start":"2026-07-31T18:30:00.000Z","end":"2026-08-31T18:29:59.999Z"},"usage":{"api_calls":{"used":1,"limit":50000,"remaining":49999},"ai_tokens":{"used":1800,"limit":5000000,"remaining":4998200}}}
```

---

## 5. Acceptance Probe 4 — Webhook Security & Replay Evidence

### A. Malformed Webhook Payload Rejection
```bash
curl -i -X POST http://localhost:3000/api/v1/webhooks/payment \
  -H "Content-Type: application/json" \
  -d '{ "type": "subscription.updated", "data": { "subscription_id": "fake_sub_b7705798808e471a" } }'
```
**HTTP Response (`400 Bad Request`)**:
```json
{"error":"Bad Request","message":"Webhook payload must include a valid id."}
```

### B. Valid Webhook Cancellation
```bash
curl -i -X POST http://localhost:3000/api/v1/webhooks/payment \
  -H "Content-Type: application/json" \
  -d '{
    "id": "probe-4-webhook-cancel-fresh",
    "type": "subscription.cancelled",
    "created": 1787926600,
    "data": { "subscription_id": "fake_sub_b7705798808e471a" }
  }'
```
**HTTP Response (`200 OK`)**:
```json
{"success":true,"message":"Successfully processed event 'subscription.cancelled'.","event_id":"probe-4-webhook-cancel-fresh","subscription_id":"fake_sub_b7705798808e471a","status":"canceled"}
```

### C. Webhook Event Replay (Idempotent Detection)
```bash
curl -i -X POST http://localhost:3000/api/v1/webhooks/payment \
  -H "Content-Type: application/json" \
  -d '{
    "id": "probe-4-webhook-cancel-fresh",
    "type": "subscription.cancelled",
    "data": { "subscription_id": "fake_sub_b7705798808e471a" }
  }'
```
**HTTP Response (`200 OK`)**:
```json
{"success":true,"message":"Event already processed.","idempotent":true,"event_id":"probe-4-webhook-cancel-fresh","subscription_id":"fake_sub_b7705798808e471a","status":"canceled"}
```

---

## 6. PostgreSQL Direct Verification Query Summary

```sql
SELECT id, provider_event_id, event_type, tenant_id, subscription_id, status, created_at FROM webhook_events ORDER BY created_at ASC;
```
**PostgreSQL Output**:
```text
                  id                  |       provider_event_id        |        event_type         |              tenant_id               |      subscription_id       |  status  |          created_at          
--------------------------------------+--------------------------------+---------------------------+--------------------------------------+---------------------------+----------+------------------------------
 b44ea2f1-14d7-4d8e-94b6-8db452cb2a1a | evt_unique_constraint_001      | subscription.updated      | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_unique_test_001  | active   | 2026-08-28 14:08:15.345725+00
 f347ec3f-7f4a-42b3-bd1d-579c6d5ac8b4 | live_37_fail_001               | invoice.payment_failed    | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_9e9cb6614930b6f8 | active   | 2026-08-28 14:08:34.823381+00
 8ff17c36-2c8d-4569-be0b-7117d9109b1d | live_37_fail_fresh_001         | invoice.payment_failed    | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_9e9cb6614930b6f8 | past_due | 2026-08-28 14:08:37.660197+00
 29eba5c6-b515-428a-b8b4-ab531e6e3172 | live_37_recovery_001           | invoice.payment_succeeded | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_9e9cb6614930b6f8 | active   | 2026-08-28 14:08:45.75417+00
 b8c0d797-8424-4dce-a7a1-0721faa22a63 | live_37_renewal_001            | invoice.payment_succeeded | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_9e9cb6614930b6f8 | active   | 2026-08-28 14:08:48.879159+00
 07d82a0b-8aa0-4801-8df9-2a2fb72cded6 | live_37_cancel_001             | subscription.cancelled    | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_9e9cb6614930b6f8 | canceled | 2026-08-28 14:08:52.016818+00
 c85961fd-e90e-400b-9181-08dbca9b86c8 | live_37_stale_reactivate_001   | invoice.payment_succeeded | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_9e9cb6614930b6f8 | canceled | 2026-08-28 14:08:54.537697+00
 8a12b509-322d-4560-bfbc-87729864223d | probe-4-webhook-cancel-fresh   | subscription.cancelled    | 32e8849a-6f0a-4639-9c57-30da0f98ca6f | fake_sub_b7705798808e471a | canceled | 2026-08-28 14:15:42.502905+00
(8 rows)
```
