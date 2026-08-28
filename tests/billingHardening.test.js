const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { getDemoTenant } = require('../src/services/tenantService');
const { getOrCreateActiveSubscription, getTenantSubscriptionDetails } = require('../src/services/subscriptionService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('Billing Hardening - full subscription lifecycle (Free -> Pro -> Free -> Canceled) maintains DB integrity', async () => {
  const tenant = await getDemoTenant();

  // 1. Initial Free plan subscription
  await getOrCreateActiveSubscription(tenant.id);
  const sub1 = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(sub1.subscription.plan.name, 'Free');
  assert.strictEqual(sub1.subscription.status, 'active');

  // 2. Upgrade to Pro via checkout
  const resPro = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  assert.strictEqual(resPro.body.checkout.plan, 'Pro');
  const sub2 = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(sub2.subscription.plan.name, 'Pro');
  assert.strictEqual(sub2.subscription.status, 'active');

  // 3. Downgrade to Free via checkout
  const resFree = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Free' })
    .expect(200);

  assert.strictEqual(resFree.body.checkout.plan, 'Free');
  const sub3 = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(sub3.subscription.plan.name, 'Free');

  // 4. Cancel active subscription
  await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);

  const sub4 = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(sub4.subscription.status, 'canceled');

  // Verify DB single subscription row maintained for tenant
  const activeSubs = await db.query("SELECT COUNT(*) FROM subscriptions WHERE tenant_id = $1 AND status = 'active'", [tenant.id]);
  assert.strictEqual(parseInt(activeSubs.rows[0].count, 10), 0);
});

test('Billing Hardening - single active subscription invariant enforced under multiple activations', async () => {
  const tenant = await getDemoTenant();
  const freePlanRes = await db.query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");
  const proPlanRes = await db.query("SELECT id FROM plans WHERE name = 'Pro' LIMIT 1");
  const freePlanId = freePlanRes.rows[0].id;
  const proPlanId = proPlanRes.rows[0].id;

  // Insert 2 active subscription rows manually for the tenant (simulating pre-existing data conflict)
  await db.query(
    "INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id) VALUES ($1, $2, 'active', 'sub_conflict_1')",
    [tenant.id, freePlanId]
  );
  await db.query(
    "INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id) VALUES ($1, $2, 'active', 'sub_conflict_2')",
    [tenant.id, proPlanId]
  );

  // Trigger checkout activation
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Verify EXACTLY 1 active subscription row remains in PostgreSQL for tenant
  const activeCountRes = await db.query("SELECT COUNT(*) FROM subscriptions WHERE tenant_id = $1 AND status = 'active'", [tenant.id]);
  assert.strictEqual(parseInt(activeCountRes.rows[0].count, 10), 1);
});

test('Billing Hardening - expired billing period auto-rollover to current calendar month boundaries', async () => {
  const tenant = await getDemoTenant();
  const proPlanRes = await db.query("SELECT id FROM plans WHERE name = 'Pro' LIMIT 1");

  // Create subscription with expired billing period (2 months ago)
  const expiredStart = new Date(2025, 0, 1);
  const expiredEnd = new Date(2025, 0, 31, 23, 59, 59, 999);

  await db.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, 'active', $3, $4)`,
    [tenant.id, proPlanRes.rows[0].id, expiredStart, expiredEnd]
  );

  const subDetails = await getTenantSubscriptionDetails(tenant.id);

  // Verify current_period_start and current_period_end automatically rolled forward to current calendar month
  const now = new Date();
  const expectedStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const expectedEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();

  assert.strictEqual(subDetails.subscription.current_period_start, expectedStart);
  assert.strictEqual(subDetails.subscription.current_period_end, expectedEnd);
});

test('Billing Hardening - exact month boundary inclusion and exclusion logic', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const periodStart = new Date(sub.current_period_start);
  const periodEnd = new Date(sub.current_period_end);

  // Event exactly at periodStart (00:00:00.000) -> INCLUDED
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'exact-start-event', 'API_CALL', 1, $2)`,
    [tenant.id, periodStart]
  );

  // Event exactly at periodEnd (23:59:59.999) -> INCLUDED
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'exact-end-event', 'API_CALL', 1, $2)`,
    [tenant.id, periodEnd]
  );

  // Event 1ms before periodStart -> EXCLUDED
  const beforeStart = new Date(periodStart.getTime() - 1);
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'before-start-event', 'API_CALL', 1, $2)`,
    [tenant.id, beforeStart]
  );

  // Event 1ms after periodEnd -> EXCLUDED
  const afterEnd = new Date(periodEnd.getTime() + 1);
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'after-end-event', 'API_CALL', 1, $2)`,
    [tenant.id, afterEnd]
  );

  const res = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  // Exactly 2 boundary events counted
  assert.strictEqual(res.body.usage.api_calls.used, 2);
});

test('Billing Hardening - webhook rejects tenant_id mismatch for subscription (HTTP 400)', async () => {
  const tenantA = await getDemoTenant();
  const tenantBRes = await db.query("INSERT INTO tenants (name) VALUES ('Spoofed Tenant') RETURNING *");
  const tenantB = tenantBRes.rows[0];

  const sub = await getOrCreateActiveSubscription(tenantA.id);
  const providerSubId = 'fake_sub_tenant_mismatch_test';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  // Send webhook supplying Tenant B's ID for Tenant A's subscription
  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_spoofed_tenant_001',
      type: 'subscription.updated',
      data: {
        subscription_id: providerSubId,
        tenant_id: tenantB.id, // Mismatch!
        status: 'active',
      },
    })
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
  assert.match(res.body.message, /Tenant ID mismatch/i);
});
