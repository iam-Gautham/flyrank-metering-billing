# FlyRank Usage Metering & Billing Engine - Build Log

This document records the engineering decisions, AI pair-programming workflow, bugs discovered, fixes applied, testing milestones, and architectural evolution of the FlyRank Usage Metering & Billing Engine.

---

## 1. Overview & AI Collaboration Strategy

- **AI Assistant**: Antigravity AI (pair programming).
- **Core Technology Stack**: Node.js, Express.js, PostgreSQL 16 (Docker), `pg` driver, Node.js built-in test runner (`node --test`), Supertest.
- **Primary Goal**: Build a production-ready, zero-cost usage metering, quota enforcement, integer token pricing, and payment webhook engine with 100% database-enforced idempotency, transaction safety, and multi-tenant isolation.

---

## 2. Key Architecture & Design Decisions

### A. Zero-Cost Payment Provider Abstraction
- **Decision**: Created an abstract payment provider factory (`src/services/paymentProvider.js`) backed by `FakePaymentProvider` (`src/services/fakePaymentProvider.js`).
- **Rationale**: Allowed zero-cost development and testing locally (₹0 / $0) without requiring real Stripe API keys, paid accounts, credit cards, or external network requests.
- **Production Mapping**: Designed `FakePaymentProvider` methods to mirror Stripe SDK calls (`stripe.checkout.sessions.create`, `stripe.subscriptions.retrieve`, `stripe.subscriptions.cancel`).

### B. Explicit Usage Event Separation (`API_CALL` vs `AI_TOKENS`)
- **Decision**: Every successful `POST /api/v1/generate` request atomically writes two usage events into PostgreSQL:
  1. `usage_type = 'API_CALL'`, `quantity = 1`, `cost_cents = 0` (Idempotency key: `${idempotencyKey}:api`)
  2. `usage_type = 'AI_TOKENS'`, `quantity = total_tokens`, stored token categories & calculated `cost_cents` (Idempotency key: `${idempotencyKey}:tokens`)
- **Rationale**: Preserves precise quota calculations (`COUNT(*)` for API calls vs `SUM(quantity)` for tokens) and allows granular token category pricing audit.

### C. Integer Monetary Arithmetic (Nano-Cents)
- **Decision**: Avoided JavaScript floating-point arithmetic for money calculations by using integer nano-cents ($1 \text{ USD cent} = 1,000,000 \text{ nano-cents}$).
- **Formula**: `costCents = Math.floor((totalNanoCents + 500000) / 1000000)`
- **Rationale**: Eliminates IEEE 754 floating-point rounding errors in billable event cost calculations.

### D. Database-Enforced Single Active Subscription Invariant
- **Decision**: Added transactional logic `UPDATE subscriptions SET status = 'canceled' WHERE tenant_id = $1 AND id != $2 AND status = 'active'` across checkouts and webhooks whenever a subscription is activated.
- **Rationale**: Prevents a tenant from ever accumulating duplicate `active` subscriptions during concurrent operations.

### E. Expired Billing Period Auto-Rollover
- **Decision**: If a subscription's stored `current_period_end` is in the past (`periodEnd < now`), queries automatically roll forward to current calendar month boundaries (`[1st 00:00:00.000, Last day 23:59:59.999]`).
- **Rationale**: Prevents expired billing periods from freezing current usage queries or allowing unmetered access.

---

## 3. Major Bugs Discovered & Fixes Applied

| # | Bug / Vulnerability | Root Cause | Resolution / Fix |
|---|---|---|---|
| 1 | **Race Condition on Quota Oversubscription** | Concurrent HTTP requests near limit checking quota without row locks. | Implemented `SELECT ... FOR UPDATE` locking on subscription rows inside atomic PostgreSQL transactions (`BEGIN`...`COMMIT`). |
| 2 | **Duplicate Usage Events on Retries** | Application-level check ran after quota checks. | Placed `findUsageEvent` check FIRST in `generateController.js` before transaction execution; wrapped inserts in unique constraint `23505` error handling. |
| 3 | **Cross-Tenant Webhook Manipulation** | Webhook resolved subscription by ID but ignored request body `tenant_id`. | Added strict validation in `webhookService.js` comparing `data.tenant_id` against `sub.tenant_id`, rejecting mismatches with HTTP 400 Bad Request. |
| 4 | **Stale Webhook State Overwrite** | Delayed cancellation or older payment success event overwriting newer subscription status. | Added `event_created_at` timestamp comparison against `MAX(event_created_at)` in `webhook_events`. Stale events are logged for audit but skipped for subscription state mutations. |
| 5 | **Duplicate Active Subscriptions** | Activating a new subscription inserted a row without deactivating prior active rows. | Added automatic deactivation query inside transactions whenever a subscription is activated. |

---

## 4. Testing & Hardening Progression

1. **Phase 2.6 - 2.11**: Built core `generate` controller, idempotency, token cost pricing, read-only `GET /api/v1/usage`, and dual usage events (`API_CALL` + `AI_TOKENS`). (22 passing tests).
2. **Phase 3.1 - 3.3**: Added payment provider abstraction (`FakePaymentProvider`), zero-cost checkout flow (`POST /subscription/checkout`), subscription cancellation (`POST /subscription/cancel`), and initial webhooks. (38 passing tests).
3. **Phase 3.4**: Added webhook concurrency protection, out-of-order event detection, and rollback safety. (46 passing tests).
4. **Phase 3.5**: Hardened billing state machine, single active subscription invariant, and expired period auto-rollover. (51 passing tests).
5. **Phase 3.6 - 3.7**: Hardened production webhooks (`webhook_events` persistence table), invoice payment failure/recovery handling, renewal period updates, and comprehensive integration testing. (66 passing tests).
6. **Phase 3.8**: Final production-readiness pass, capstone submission files creation, and clean-machine acceptance probe verification. (66 passing tests).

---

## 5. Rejected / Changed Approaches

- **Rejected**: Integrating real Stripe/Razorpay SDKs requiring live test keys or paid accounts.
  - *Reason*: Requirement explicitly dictated ₹0 / $0 local development without external credentials.
- **Rejected**: Storing floating-point currency values (e.g. `29.00`).
  - *Reason*: Floating-point math introduces rounding drift. Integer cents and nano-cents provided deterministic precision.
