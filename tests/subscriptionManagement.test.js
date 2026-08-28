const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { getDemoTenant } = require('../src/services/tenantService');
const { getOrCreateActiveSubscription } = require('../src/services/subscriptionService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('GET /api/v1/subscription - retrieves tenant active subscription details', async () => {
  const tenant = await getDemoTenant();

  // Create checkout session for Pro plan
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  const res = await request(app)
    .get('/api/v1/subscription')
    .expect(200);

  assert.strictEqual(res.body.tenant.name, 'Demo Tenant');
  assert.strictEqual(res.body.subscription.provider, 'fake');
  assert.strictEqual(res.body.subscription.plan.name, 'Pro');
  assert.strictEqual(res.body.subscription.status, 'active');
  assert.ok(res.body.subscription.customer_id.startsWith('fake_cust_'));
  assert.ok(res.body.subscription.subscription_id.startsWith('fake_sub_'));
  assert.ok(res.body.subscription.current_period_start);
  assert.ok(res.body.subscription.current_period_end);
});

test('POST /api/v1/subscription/cancel - cancels active subscription and updates DB status to canceled', async () => {
  const tenant = await getDemoTenant();

  // Create checkout session for Pro plan
  const checkoutRes = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  const providerSubId = checkoutRes.body.checkout.subscription_id;

  // Cancel subscription
  const cancelRes = await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);

  assert.strictEqual(cancelRes.body.success, true);
  assert.strictEqual(cancelRes.body.subscription.status, 'canceled');
  assert.strictEqual(cancelRes.body.subscription.plan, 'Pro');

  // Verify PostgreSQL status changes to 'canceled' and billing period is preserved
  const dbSubRes = await db.query('SELECT * FROM subscriptions WHERE stripe_subscription_id = $1', [providerSubId]);
  assert.strictEqual(dbSubRes.rows.length, 1);
  assert.strictEqual(dbSubRes.rows[0].status, 'canceled');
  assert.ok(dbSubRes.rows[0].current_period_start);
  assert.ok(dbSubRes.rows[0].current_period_end);
});

test('POST /api/v1/subscription/cancel - returns 404 when no active subscription exists', async () => {
  const res = await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(404);

  assert.strictEqual(res.body.error, 'Not Found');
  assert.match(res.body.message, /No active subscription found to cancel/i);
});

test('POST /api/v1/subscription/cancel - returns 404 on repeated cancellation', async () => {
  const tenant = await getDemoTenant();
  await getOrCreateActiveSubscription(tenant.id);

  // First cancel -> 200
  await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);

  // Second cancel -> 404 (no active subscription)
  const res2 = await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(404);

  assert.strictEqual(res2.body.error, 'Not Found');
});

test('Usage and quota behavior remains correct post-cancellation (falls back to default Free plan logic)', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  // Cancel active subscription
  await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);

  // Subsequent generate call will automatically re-initialize default Free subscription context
  const genRes = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'post-cancel-key-001')
    .send({ input_tokens: 100, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);

  assert.strictEqual(genRes.body.success, true);
  assert.strictEqual(genRes.body.usage.total_tokens, 100);
});
