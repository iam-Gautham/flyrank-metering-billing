const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { validateConfig } = require('../src/config');
const { calculateTokenCost } = require('../src/services/pricingService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

// ==========================================
// 1. Production Configuration & Environment Audit
// ==========================================

test('Phase 6.2 - 1.1 Config Audit: validateConfig validates DB_MAX_RETRIES parameter', () => {
  const origRetries = process.env.DB_MAX_RETRIES;
  try {
    process.env.DB_MAX_RETRIES = '-1';
    assert.throws(() => validateConfig(), /Invalid DB_MAX_RETRIES configuration/);
  } finally {
    if (origRetries !== undefined) {
      process.env.DB_MAX_RETRIES = origRetries;
    } else {
      delete process.env.DB_MAX_RETRIES;
    }
  }
});

// ==========================================
// 2. Production API Security & Input Validation Audit
// ==========================================

test('Phase 6.2 - 2.1 API Audit: malformed JSON payload returns HTTP 400 Bad Request', async () => {
  const res = await request(app)
    .post('/api/v1/generate')
    .set('Content-Type', 'application/json')
    .send('{ "input_tokens": 100, invalid_json }')
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
  assert.strictEqual(res.body.message, 'Invalid JSON payload format.');
});

test('Phase 6.2 - 2.2 API Audit: SQL injection attempt in invoice ID parameter returns 404 without leaking SQL error', async () => {
  const res = await request(app)
    .get("/api/v1/invoices/inv_123' OR '1'='1")
    .expect(404);

  assert.strictEqual(res.body.error, 'Not Found');
  assert.strictEqual(res.body.stack, undefined);
  assert.strictEqual(res.body.sql, undefined);
});

// ==========================================
// 3. End-to-End Billing Lifecycle & Integer Math Audit
// ==========================================

test('Phase 6.2 - 3.1 E2E Billing Audit: Checkout -> Usage Generation -> Itemized Invoice Calculation', async () => {
  // 1. Checkout Pro plan
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // 2. Generate 1,000,000 input tokens ($3.00 = 300 cents) and 100,000 output tokens ($1.50 = 150 cents)
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'e2e-prod-key-1')
    .send({
      input_tokens: 1000000,
      cached_tokens: 0,
      output_tokens: 100000,
      reasoning_tokens: 0,
    })
    .expect(200);

  // 3. Fetch invoice statement
  const invRes = await request(app).get('/api/v1/invoices/current').expect(200);
  const invoice = invRes.body.invoice;

  assert.strictEqual(invoice.plan_name, 'Pro');
  assert.strictEqual(invoice.subtotal_cents, 2900 + 300 + 150); // $29 Pro + $3 input + $1.50 output = 3350 cents ($33.50)
  assert.strictEqual(invoice.total_cents, 3350);
  assert.strictEqual(invoice.currency, 'USD');
});

// ==========================================
// 4. Production Health & Readiness Verification
// ==========================================

test('Phase 6.2 - 4.1 Probe Audit: All health, liveness, and readiness probes return 200 OK under healthy DB', async () => {
  await request(app).get('/health').expect(200);
  await request(app).get('/api/v1/health').expect(200);
  await request(app).get('/health/liveness').expect(200);
  await request(app).get('/health/readiness').expect(200);
});
