const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { getDemoTenant } = require('../src/services/tenantService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('POST /api/v1/subscription/checkout - Idempotency-Key header returns idempotent cached session', async () => {
  const idempotencyKey = 'checkout-idempotent-key-001';

  // 1. Initial checkout request
  const res1 = await request(app)
    .post('/api/v1/subscription/checkout')
    .set('Idempotency-Key', idempotencyKey)
    .send({ plan_name: 'Pro' })
    .expect(200);

  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.checkout.plan, 'Pro');
  assert.strictEqual(res1.body.checkout.status, 'active');

  // 2. Repeat checkout request with same Idempotency-Key
  const res2 = await request(app)
    .post('/api/v1/subscription/checkout')
    .set('Idempotency-Key', idempotencyKey)
    .send({ plan_name: 'Pro' })
    .expect(200);

  assert.strictEqual(res2.body.success, true);
  assert.strictEqual(res2.body.idempotent, true);
  assert.strictEqual(res2.body.checkout.plan, 'Pro');

  // Verify DB contains exactly 1 CHECKOUT_EVENT marker
  const markerCount = await db.query(
    "SELECT COUNT(*) FROM usage_events WHERE idempotency_key = 'checkout:checkout-idempotent-key-001'"
  );
  assert.strictEqual(parseInt(markerCount.rows[0].count, 10), 1);
});

test('POST /api/v1/subscription/checkout - concurrent duplicate checkout requests with same Idempotency-Key header', async () => {
  const idempotencyKey = 'checkout-concurrent-key-002';
  const tenant = await getDemoTenant();

  const [res1, res2, res3] = await Promise.all([
    request(app).post('/api/v1/subscription/checkout').set('Idempotency-Key', idempotencyKey).send({ plan_name: 'Pro' }),
    request(app).post('/api/v1/subscription/checkout').set('Idempotency-Key', idempotencyKey).send({ plan_name: 'Pro' }),
    request(app).post('/api/v1/subscription/checkout').set('Idempotency-Key', idempotencyKey).send({ plan_name: 'Pro' }),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res3.status, 200);

  // Exactly 1 active subscription in PostgreSQL subscriptions table
  const activeSubCount = await db.query(
    "SELECT COUNT(*) FROM subscriptions WHERE tenant_id = $1 AND status = 'active'",
    [tenant.id]
  );
  assert.strictEqual(parseInt(activeSubCount.rows[0].count, 10), 1);

  // Exactly 1 CHECKOUT_EVENT marker stored in PostgreSQL usage_events table
  const markerCount = await db.query(
    "SELECT COUNT(*) FROM usage_events WHERE idempotency_key = 'checkout:checkout-concurrent-key-002'"
  );
  assert.strictEqual(parseInt(markerCount.rows[0].count, 10), 1);
});
