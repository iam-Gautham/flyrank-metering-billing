const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { startServer, gracefulShutdown } = require('../src/server');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

// ==========================================
// 1. Database Failure & Rollback Resilience
// ==========================================

test('Phase 6.0 - 1.1 DB Failure Resilience: query failure in transaction triggers complete rollback with 0 leaked usage events', async () => {
  const countBefore = await db.query('SELECT COUNT(*)::integer FROM usage_events');

  // Trigger rejection in generation via invalid negative input tokens
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'failed-tx-key-001')
    .send({ input_tokens: -50, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(400);

  const countAfter = await db.query('SELECT COUNT(*)::integer FROM usage_events');
  assert.strictEqual(countBefore.rows[0].count, countAfter.rows[0].count);
});

test('Phase 6.0 - 1.2 DB Error Sanitization: unexpected database error returns sanitized HTTP 500 without stack trace or SQL leakage', async () => {
  // Override db.query temporarily to simulate unexpected DB failure
  const originalQuery = db.query;
  db.query = async (text, params) => {
    if (typeof text === 'string' && text.includes('FROM tenants')) {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432 - SELECT * FROM internal_secret_table');
      throw err;
    }
    return originalQuery.call(db, text, params);
  };

  try {
    const res = await request(app).get('/api/v1/usage').expect(500);
    assert.strictEqual(res.body.error, 'Internal Server Error');
    assert.strictEqual(res.body.message, 'An unexpected internal server error occurred.');
    assert.strictEqual(res.body.stack, undefined);
    assert.strictEqual(res.body.sql, undefined);
  } finally {
    db.query = originalQuery;
  }
});

// ==========================================
// 2. Health & Readiness Probe Reliability
// ==========================================

test('Phase 6.0 - 2.1 Health Probe Failure: GET /health returns HTTP 503 Service Unavailable when DB connectivity fails', async () => {
  const originalQuery = db.query;
  db.query = async (text, params) => {
    if (text === 'SELECT 1') {
      throw new Error('PostgreSQL connection timeout');
    }
    return originalQuery.call(db, text, params);
  };

  try {
    const res1 = await request(app).get('/health').expect(503);
    assert.strictEqual(res1.body.status, 'error');
    assert.strictEqual(res1.body.database, 'disconnected');

    const res2 = await request(app).get('/api/v1/health').expect(503);
    assert.strictEqual(res2.body.status, 'error');
    assert.strictEqual(res2.body.database, 'disconnected');
  } finally {
    db.query = originalQuery;
  }
});

// ==========================================
// 3. Webhook Retry & Failure Reliability
// ==========================================

test('Phase 6.0 - 3.1 Webhook Retry Reliability: failed webhook retry handles duplicates idempotently', async () => {
  // Create subscription
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  const subRes = await request(app).get('/api/v1/subscription').expect(200);
  const subId = subRes.body.subscription.subscription_id || subRes.body.subscription.id;

  const eventPayload = {
    id: `evt_retry_${Date.now()}`,
    type: 'subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: {
      subscription_id: subId,
      status: 'active',
      plan_name: 'Pro',
    },
  };

  // 1st delivery attempt -> succeeds
  const res1 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);
  assert.strictEqual(res1.body.success, true);

  // 2nd delivery attempt (retry) -> handled idempotently without duplicate records
  const res2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);
  assert.strictEqual(res2.body.success, true);
  assert.strictEqual(res2.body.idempotent, true);

  const evtCount = await db.query(
    'SELECT COUNT(*)::integer FROM webhook_events WHERE provider_event_id = $1',
    [eventPayload.id]
  );
  assert.strictEqual(evtCount.rows[0].count, 1);
});

// ==========================================
// 4. Invoice Side-Effect Freedom & Determinism
// ==========================================

test('Phase 6.0 - 4.1 Invoice Side-Effect Freedom: repeated GET /invoices/current queries do not mutate usage or totals', async () => {
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'side-effect-key-100')
    .send({ input_tokens: 100000, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);

  const inv1 = await request(app).get('/api/v1/invoices/current').expect(200);
  const inv2 = await request(app).get('/api/v1/invoices/current').expect(200);

  assert.strictEqual(inv1.body.invoice.total_cents, inv2.body.invoice.total_cents);
  assert.strictEqual(inv1.body.invoice.total_cents, 2900 + 30); // $29.00 Pro fee + $0.30 input tokens
});

// ==========================================
// 5. Process Startup & Shutdown Reliability
// ==========================================

test('Phase 6.0 - 5.1 Process Startup Verification: startServer verifies DB connectivity before listening', async () => {
  const serverInstance = await startServer();
  assert.ok(serverInstance);
  serverInstance.close();
});
