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
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('Billing State Machine - complete state transition lifecycle (Free -> Pro -> past_due -> active recovery -> canceled)', async () => {
  const tenant = await getDemoTenant();

  // 1. Initial Free subscription
  await getOrCreateActiveSubscription(tenant.id);
  const sub1 = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(sub1.subscription.plan.name, 'Free');
  assert.strictEqual(sub1.subscription.status, 'active');

  // 2. Free -> Pro via checkout
  const checkoutRes = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  const providerSubId = checkoutRes.body.checkout.subscription_id;
  const sub2 = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(sub2.subscription.plan.name, 'Pro');
  assert.strictEqual(sub2.subscription.status, 'active');

  // 3. Pro -> past_due via invoice.payment_failed webhook
  const resFail = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_state_fail_001',
      type: 'invoice.payment_failed',
      data: { subscription_id: providerSubId },
    })
    .expect(200);

  assert.strictEqual(resFail.body.status, 'past_due');

  // While past_due, GET /api/v1/usage falls back to Free plan quota
  const usagePastDue = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  assert.strictEqual(usagePastDue.body.plan.name, 'Free');
  assert.strictEqual(usagePastDue.body.usage.ai_tokens.limit, 100000);

  // Repeated payment failure is idempotent
  const resFail2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_state_fail_001',
      type: 'invoice.payment_failed',
      data: { subscription_id: providerSubId },
    })
    .expect(200);

  assert.strictEqual(resFail2.body.idempotent, true);

  // 4. past_due -> active recovery via invoice.payment_succeeded webhook
  const resRecovery = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_state_recovery_001',
      type: 'invoice.payment_succeeded',
      data: { subscription_id: providerSubId, status: 'paid' },
    })
    .expect(200);

  assert.strictEqual(resRecovery.body.status, 'active');

  // GET /api/v1/usage returns Pro plan limits again
  const usageRecovered = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  assert.strictEqual(usageRecovered.body.plan.name, 'Pro');
  assert.strictEqual(usageRecovered.body.usage.ai_tokens.limit, 5000000);

  // 5. Active -> canceled via cancellation endpoint
  await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);

  const subCanceled = await getTenantSubscriptionDetails(tenant.id);
  assert.strictEqual(subCanceled.subscription.status, 'canceled');
});

test('Billing Renewal - period update, quota reset, and previous-period usage exclusion', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_renewal_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  // Seed usage event in PREVIOUS period
  const oldPeriodStart = new Date(2026, 6, 1);
  const oldPeriodEnd = new Date(2026, 6, 31, 23, 59, 59, 999);

  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, output_tokens, created_at)
     VALUES ($1, 'old-period-usage-001', 'AI_TOKENS', 80000, 40000, 40000, $2)`,
    [tenant.id, oldPeriodStart]
  );

  // Process renewal webhook with new period bounds
  const newPeriodStart = '2026-08-01T00:00:00.000Z';
  const newPeriodEnd = '2026-08-31T23:59:59.999Z';

  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_renewal_001',
      type: 'invoice.payment_succeeded',
      data: {
        subscription_id: providerSubId,
        current_period_start: newPeriodStart,
        current_period_end: newPeriodEnd,
      },
    })
    .expect(200);

  // Verify usage query reports 0 tokens used in the new billing period
  const usageRes = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  assert.strictEqual(usageRes.body.usage.ai_tokens.used, 0);
  assert.strictEqual(usageRes.body.period.start, newPeriodStart);
  assert.strictEqual(usageRes.body.period.end, newPeriodEnd);
});

test('Concurrency & State Hardening - concurrent payment success, failure, and duplicate webhooks', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_concurrent_state_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const baseTime = Math.floor(Date.now() / 1000);

  const evtSuccess = {
    id: 'evt_conc_success_001',
    type: 'invoice.payment_succeeded',
    created: baseTime + 10,
    data: { subscription_id: providerSubId },
  };

  const evtFail = {
    id: 'evt_conc_fail_001',
    type: 'invoice.payment_failed',
    created: baseTime + 5,
    data: { subscription_id: providerSubId },
  };

  // Fire concurrent success, failure, and duplicate webhooks
  const [res1, res2, res3] = await Promise.all([
    request(app).post('/api/v1/webhooks/payment').send(evtSuccess),
    request(app).post('/api/v1/webhooks/payment').send(evtFail),
    request(app).post('/api/v1/webhooks/payment').send(evtSuccess),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res3.status, 200);

  // Verify latest event (evtSuccess, created = baseTime + 10) takes effect -> status = 'active'
  const dbSub = await db.query('SELECT status FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSub.rows[0].status, 'active');

  // Verify exactly 1 active subscription row exists for tenant
  const activeCount = await db.query("SELECT COUNT(*) FROM subscriptions WHERE tenant_id = $1 AND status = 'active'", [tenant.id]);
  assert.strictEqual(parseInt(activeCount.rows[0].count, 10), 1);
});

test('Security & Stale Event Protection - stale payment success event cannot reactivate a newer canceled subscription', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_stale_reactivate_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const baseTime = Math.floor(Date.now() / 1000);

  // 1. Process NEWER cancellation event (created = baseTime + 200)
  const resCancel = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_newer_cancel_200',
      type: 'subscription.cancelled',
      created: baseTime + 200,
      data: { subscription_id: providerSubId },
    })
    .expect(200);

  assert.strictEqual(resCancel.body.status, 'canceled');

  // 2. Process STALE payment success event (created = baseTime + 100) attempting reactivation
  const resStaleSuccess = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_stale_success_100',
      type: 'invoice.payment_succeeded',
      created: baseTime + 100,
      data: { subscription_id: providerSubId },
    })
    .expect(200);

  assert.strictEqual(resStaleSuccess.body.stale, true);

  // Verify PostgreSQL subscription status remains 'canceled'
  const dbSub = await db.query('SELECT status FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSub.rows[0].status, 'canceled');
});
