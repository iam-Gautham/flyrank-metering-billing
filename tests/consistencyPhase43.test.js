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
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('Consistency Phase 4.3 - PostgreSQL schema-enforced single active subscription invariant', async () => {
  const tenant = await getDemoTenant();
  const freePlanRes = await db.query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");
  const proPlanRes = await db.query("SELECT id FROM plans WHERE name = 'Pro' LIMIT 1");

  const freePlanId = freePlanRes.rows[0].id;
  const proPlanId = proPlanRes.rows[0].id;

  // 1. Insert first active subscription row
  await db.query(
    "INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active')",
    [tenant.id, freePlanId]
  );

  // 2. Attempt to insert a second active subscription row directly into DB for same tenant
  let errorOccurred = false;
  try {
    await db.query(
      "INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active')",
      [tenant.id, proPlanId]
    );
  } catch (err) {
    errorOccurred = true;
    assert.strictEqual(err.code, '23505');
    assert.strictEqual(err.constraint, 'idx_single_active_subscription_per_tenant');
  }

  assert.strictEqual(errorOccurred, true);
});

test('Consistency Phase 4.3 - concurrent checkout activations do not produce 500 errors and preserve single active subscription', async () => {
  const tenant = await getDemoTenant();
  await getOrCreateActiveSubscription(tenant.id);

  // Execute 3 concurrent checkout requests with different plan names
  const [res1, res2, res3] = await Promise.all([
    request(app).post('/api/v1/subscription/checkout').send({ plan_name: 'Pro' }),
    request(app).post('/api/v1/subscription/checkout').send({ plan_name: 'Free' }),
    request(app).post('/api/v1/subscription/checkout').send({ plan_name: 'Pro' }),
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
});

test('Consistency Phase 4.3 - getOrCreateActiveSubscription handles 23505 partial unique index conflict safely under real concurrency', async () => {
  const tenant = await getDemoTenant();

  // Call getOrCreateActiveSubscription concurrently
  const [sub1, sub2] = await Promise.all([
    getOrCreateActiveSubscription(tenant.id),
    getOrCreateActiveSubscription(tenant.id),
  ]);

  assert.ok(sub1);
  assert.ok(sub2);
  assert.strictEqual(sub1.status, 'active');
  assert.strictEqual(sub2.status, 'active');

  const activeSubs = await db.query(
    "SELECT COUNT(*) FROM subscriptions WHERE tenant_id = $1 AND status = 'active'",
    [tenant.id]
  );
  assert.strictEqual(parseInt(activeSubs.rows[0].count, 10), 1);
});

test('Consistency Phase 4.3 - Webhook Ordering: newer event followed by stale event does not overwrite state', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_stale_ordering_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const newerTimestamp = new Date('2026-08-28T12:00:00Z').getTime();
  const olderTimestamp = new Date('2026-08-28T10:00:00Z').getTime();

  // 1. Process newer subscription.updated event (Pro)
  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_newer_001',
      type: 'subscription.updated',
      timestamp: newerTimestamp,
      data: {
        subscription_id: providerSubId,
        status: 'active',
        plan_name: 'Pro',
      },
    })
    .expect(200);

  // Verify DB active plan is Pro
  const subRes1 = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.id = $1",
    [sub.id]
  );
  assert.strictEqual(subRes1.rows[0].plan_name, 'Pro');

  // 2. Process older/stale subscription.updated event (Free)
  const staleRes = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_older_stale_002',
      type: 'subscription.updated',
      timestamp: olderTimestamp,
      data: {
        subscription_id: providerSubId,
        status: 'active',
        plan_name: 'Free',
      },
    })
    .expect(200);

  assert.strictEqual(staleRes.body.stale, true);

  // Verify DB active plan remains Pro (not overwritten by stale event)
  const subRes2 = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.id = $1",
    [sub.id]
  );
  assert.strictEqual(subRes2.rows[0].plan_name, 'Pro');
});

test('Consistency Phase 4.3 - past_due status blocks Pro quota access and falls back to Free plan limits', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_consistency_past_due_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  // Upgrade to Pro first
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Trigger payment failure -> status becomes past_due
  const activeSubRes = await db.query("SELECT stripe_subscription_id FROM subscriptions WHERE tenant_id = $1 AND status = 'active'", [tenant.id]);
  const activeSubId = activeSubRes.rows[0].stripe_subscription_id;

  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_past_due_consistency_001',
      type: 'invoice.payment_failed',
      data: { subscription_id: activeSubId },
    })
    .expect(200);

  // Verify GET /api/v1/usage returns Free limits (1,000 API calls / 100,000 tokens)
  const usageRes = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  assert.strictEqual(usageRes.body.plan.name, 'Free');
  assert.strictEqual(usageRes.body.usage.api_calls.limit, 1000);
  assert.strictEqual(usageRes.body.usage.ai_tokens.limit, 100000);
});

test('Consistency Phase 4.3 - webhook rejects tenant_id mismatch parameter spoofing with HTTP 400 Bad Request', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_tenant_spoof_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_tenant_spoof_001',
      type: 'subscription.updated',
      data: {
        subscription_id: providerSubId,
        tenant_id: '00000000-0000-0000-0000-000000000000', // Mismatched tenant_id
        plan_name: 'Pro',
      },
    })
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
  assert.strictEqual(res.body.message.includes('Tenant ID mismatch'), true);
});

test('Consistency Phase 4.3 - unrelated non-23505 database errors still propagate cleanly as HTTP 500', async () => {
  const originalQuery = db.query;
  db.query = async () => {
    const err = new Error('syntax error at or near "SELECT"');
    err.code = '42601'; // Syntax error code
    throw err;
  };

  try {
    const res = await request(app)
      .get('/api/v1/usage')
      .expect(500);

    assert.strictEqual(res.body.error, 'Internal Server Error');
    assert.strictEqual(res.body.message, 'An unexpected internal server error occurred.');
  } finally {
    db.query = originalQuery;
  }
});
