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
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('POST /api/v1/subscription/checkout - returns 400 when plan_name is missing or empty', async () => {
  const res1 = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({})
    .expect(400);

  assert.strictEqual(res1.body.error, 'Bad Request');
  assert.match(res1.body.message, /plan_name is required/i);

  const res2 = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: '   ' })
    .expect(400);

  assert.strictEqual(res2.body.error, 'Bad Request');
});

test('POST /api/v1/subscription/checkout - returns 404 when requested plan does not exist in DB', async () => {
  const res = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'EnterpriseUltraPlan' })
    .expect(404);

  assert.strictEqual(res.body.error, 'Not Found');
  assert.match(res.body.message, /Plan 'EnterpriseUltraPlan' not found/i);
});

test('POST /api/v1/subscription/checkout - successful Free plan checkout', async () => {
  const res = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Free' })
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.checkout.provider, 'fake');
  assert.strictEqual(res.body.checkout.plan, 'Free');
  assert.strictEqual(res.body.checkout.status, 'active');
  assert.ok(res.body.checkout.session_id.startsWith('fake_checkout_'));
  assert.ok(res.body.checkout.subscription_id.startsWith('fake_sub_'));

  // Verify PostgreSQL row
  const tenant = await getDemoTenant();
  const dbSubRes = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.tenant_id = $1 AND s.status = 'active'",
    [tenant.id]
  );

  assert.strictEqual(dbSubRes.rows.length, 1);
  assert.strictEqual(dbSubRes.rows[0].plan_name, 'Free');
  assert.strictEqual(dbSubRes.rows[0].stripe_subscription_id, res.body.checkout.subscription_id);
});

test('POST /api/v1/subscription/checkout - successful Pro plan checkout and plan upgrade without duplicate active subscriptions', async () => {
  const tenant = await getDemoTenant();

  // 1. Initial Free checkout
  const resFree = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Free' })
    .expect(200);

  assert.strictEqual(resFree.body.checkout.plan, 'Free');

  // Verify 1 active subscription in DB
  const dbCount1 = await db.query("SELECT COUNT(*) FROM subscriptions WHERE tenant_id = $1 AND status = 'active'", [tenant.id]);
  assert.strictEqual(parseInt(dbCount1.rows[0].count, 10), 1);

  // 2. Pro checkout (Plan Upgrade)
  const resPro = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  assert.strictEqual(resPro.body.success, true);
  assert.strictEqual(resPro.body.checkout.plan, 'Pro');
  assert.strictEqual(resPro.body.checkout.status, 'active');

  // Verify DB still contains EXACTLY 1 active subscription for tenant (updated to Pro)
  const dbSubRes = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.tenant_id = $1 AND s.status = 'active'",
    [tenant.id]
  );

  assert.strictEqual(dbSubRes.rows.length, 1);
  assert.strictEqual(dbSubRes.rows[0].plan_name, 'Pro');
  assert.strictEqual(dbSubRes.rows[0].stripe_subscription_id, resPro.body.checkout.subscription_id);
});
