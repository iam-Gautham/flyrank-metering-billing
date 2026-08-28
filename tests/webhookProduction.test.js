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

test('Webhook Production - subscription.deleted sets status to canceled and persists in webhook_events', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_deleted_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_deleted_001',
      type: 'subscription.deleted',
      data: { subscription_id: providerSubId },
    })
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.status, 'canceled');

  // Verify status in PostgreSQL subscriptions table
  const dbSub = await db.query('SELECT status FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSub.rows[0].status, 'canceled');

  // Verify record in webhook_events table
  const dbEvt = await db.query('SELECT * FROM webhook_events WHERE provider_event_id = $1', ['evt_deleted_001']);
  assert.strictEqual(dbEvt.rows.length, 1);
  assert.strictEqual(dbEvt.rows[0].event_type, 'subscription.deleted');
  assert.strictEqual(dbEvt.rows[0].status, 'canceled');
});

test('Webhook Production - invoice.payment_succeeded activates subscription and updates period bounds', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_invoice_success_001';
  await db.query("UPDATE subscriptions SET status = 'past_due', stripe_subscription_id = $1 WHERE id = $2", [providerSubId, sub.id]);

  const newPeriodStart = '2026-08-01T00:00:00.000Z';
  const newPeriodEnd = '2026-08-31T23:59:59.999Z';

  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_inv_success_001',
      type: 'invoice.payment_succeeded',
      data: {
        subscription_id: providerSubId,
        status: 'paid',
        current_period_start: newPeriodStart,
        current_period_end: newPeriodEnd,
      },
    })
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.status, 'active');

  // Verify subscription reactivated and period bounds updated in DB
  const dbSub = await db.query('SELECT * FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSub.rows[0].status, 'active');
  assert.strictEqual(new Date(dbSub.rows[0].current_period_start).toISOString(), newPeriodStart);
  assert.strictEqual(new Date(dbSub.rows[0].current_period_end).toISOString(), newPeriodEnd);
});

test('Webhook Production - invoice.payment_failed sets subscription status to past_due', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_invoice_fail_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_inv_fail_001',
      type: 'invoice.payment_failed',
      data: { subscription_id: providerSubId },
    })
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.status, 'past_due');

  const dbSub = await db.query('SELECT status FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSub.rows[0].status, 'past_due');
});

test('Webhook Production - webhook_events provider_event_id unique constraint prevents duplicate processing', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_unique_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const payload = {
    id: 'evt_unique_constraint_001',
    type: 'subscription.updated',
    data: {
      subscription_id: providerSubId,
      plan_name: 'Pro',
    },
  };

  // 1. First delivery -> 200 OK
  const res1 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(payload)
    .expect(200);

  assert.strictEqual(res1.body.success, true);

  // 2. Second delivery -> 200 OK (idempotent, 0 extra rows created in DB)
  const res2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(payload)
    .expect(200);

  assert.strictEqual(res2.body.idempotent, true);

  const countRes = await db.query("SELECT COUNT(*) FROM webhook_events WHERE provider_event_id = 'evt_unique_constraint_001'");
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 1);
});
