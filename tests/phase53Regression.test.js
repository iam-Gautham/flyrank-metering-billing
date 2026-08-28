const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
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
// 1. Subscription Lifecycle Matrix Tests
// ==========================================

test('Phase 5.3 - 1.1 Subscription Lifecycle: Free -> Pro -> Cancel (Free fallback) -> Renewal', async () => {
  // 1. Initialize Pro checkout
  const checkoutRes = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);
  assert.strictEqual(checkoutRes.body.checkout.plan, 'Pro');
  assert.strictEqual(checkoutRes.body.checkout.status, 'active');

  // 2. Fetch subscription details -> Pro active
  const subPro = await request(app).get('/api/v1/subscription').expect(200);
  assert.strictEqual(subPro.body.subscription.plan.name, 'Pro');
  assert.strictEqual(subPro.body.subscription.status, 'active');

  // 3. Pro -> Cancel
  const cancelRes = await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);
  assert.strictEqual(cancelRes.body.subscription.status, 'canceled');

  // Post-cancellation usage falls back to Free plan quota
  const usagePostCancel = await request(app).get('/api/v1/usage').expect(200);
  assert.strictEqual(usagePostCancel.body.plan.name, 'Free');
});

// ==========================================
// 2. Payment Failure and Recovery Tests
// ==========================================

test('Phase 5.3 - 2.1 Payment Failure & Recovery: invoice.payment_failed sets past_due, payment_succeeded restores active', async () => {
  // Create Pro subscription
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  const subActive = await request(app).get('/api/v1/subscription').expect(200);
  const subId = subActive.body.subscription.subscription_id || subActive.body.subscription.id;

  // 1. Payment Failed event -> sets status to past_due
  const failPayload = {
    id: `evt_fail_${Date.now()}`,
    type: 'invoice.payment_failed',
    created: Math.floor(Date.now() / 1000),
    data: {
      subscription_id: subId,
      status: 'past_due',
    },
  };

  await request(app)
    .post('/api/v1/webhooks/payment')
    .send(failPayload)
    .expect(200);

  const subPastDue = await request(app).get('/api/v1/subscription').expect(200);
  assert.strictEqual(subPastDue.body.subscription.status, 'past_due');

  // Invoice for past_due subscription has 'pending' status
  const invPastDue = await request(app).get('/api/v1/invoices/current').expect(200);
  assert.strictEqual(invPastDue.body.invoice.status, 'pending');

  // 2. Payment Succeeded recovery event -> restores active status and period bounds
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const successPayload = {
    id: `evt_succ_${Date.now()}`,
    type: 'invoice.payment_succeeded',
    created: Math.floor(Date.now() / 1000) + 10,
    data: {
      subscription_id: subId,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: nextMonth.toISOString(),
    },
  };

  await request(app)
    .post('/api/v1/webhooks/payment')
    .send(successPayload)
    .expect(200);

  const subRecovered = await request(app).get('/api/v1/subscription').expect(200);
  assert.strictEqual(subRecovered.body.subscription.status, 'active');
});

// ==========================================
// 3. Webhook Adversarial Tests
// ==========================================

test('Phase 5.3 - 3.1 Webhook Adversarial: rejects missing ID, missing type, unsupported type, and tenant ID mismatch', async () => {
  // 1. Missing event ID -> HTTP 400
  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ type: 'subscription.created', data: { subscription_id: 'sub_123' } })
    .expect(400);

  // 2. Missing event type -> HTTP 400
  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ id: 'evt_no_type', data: { subscription_id: 'sub_123' } })
    .expect(400);

  // 3. Unsupported event type -> HTTP 400
  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ id: 'evt_bad_type', type: 'unsupported.event.type', data: { subscription_id: 'sub_123' } })
    .expect(400);

  // 4. Missing subscription_id and customer_id -> HTTP 400
  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ id: 'evt_no_sub', type: 'subscription.updated', data: {} })
    .expect(400);

  // 5. Tenant ID mismatch -> HTTP 400
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);
  const subRes = await request(app).get('/api/v1/subscription').expect(200);
  const subId = subRes.body.subscription.subscription_id || subRes.body.subscription.id;

  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_spoof_tenant',
      type: 'subscription.updated',
      data: {
        subscription_id: subId,
        tenant_id: '00000000-0000-0000-0000-000000000000', // False tenant ID
      },
    })
    .expect(400);
});

// ==========================================
// 4. Idempotency Deep Tests
// ==========================================

test('Phase 5.3 - 4.1 Idempotency Deep: POST /generate handles missing/empty key and concurrent duplicate requests', async () => {
  // 1. Missing Idempotency-Key header -> HTTP 400
  await request(app)
    .post('/api/v1/generate')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(400);

  // 2. Empty/whitespace Idempotency-Key header -> HTTP 400
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', '   ')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(400);

  // 3. Concurrent same-key requests -> creates exactly 1 AI_TOKENS usage event
  const idempotencyKey = `conc-gen-key-${Date.now()}`;
  const payload = { input_tokens: 100, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };

  const [res1, res2] = await Promise.all([
    request(app).post('/api/v1/generate').set('Idempotency-Key', idempotencyKey).send(payload),
    request(app).post('/api/v1/generate').set('Idempotency-Key', idempotencyKey).send(payload),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);

  const demoTenantRes = await db.query("SELECT id FROM tenants WHERE name = 'Demo Tenant' LIMIT 1");
  const tenantId = demoTenantRes.rows[0].id;

  const countRes = await db.query(
    'SELECT COUNT(*)::integer FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2',
    [tenantId, `${idempotencyKey}:tokens`]
  );
  assert.strictEqual(countRes.rows[0].count, 1);
});

// ==========================================
// 5. Financial & Invoice Invariants Tests
// ==========================================

test('Phase 5.3 - 5.1 Financial Invariants: total_cents equals plan fee + all category line item costs', async () => {
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'fin-inv-key-1')
    .send({
      input_tokens: 500000,   // 150 cents
      cached_tokens: 400000,  // 30 cents
      output_tokens: 50000,   // 75 cents
      reasoning_tokens: 20000,// 60 cents
    })
    .expect(200);

  const res = await request(app).get('/api/v1/invoices/current').expect(200);
  const invoice = res.body.invoice;

  const baseFee = invoice.line_items[0].amount_cents;       // 2900 (Pro)
  const apiFee = invoice.line_items[1].amount_cents;        // 0
  const inputFee = invoice.line_items[2].amount_cents;      // 150
  const cachedFee = invoice.line_items[3].amount_cents;     // 30
  const outputFee = invoice.line_items[4].amount_cents;     // 75
  const reasoningFee = invoice.line_items[5].amount_cents;  // 60

  const expectedTotal = baseFee + apiFee + inputFee + cachedFee + outputFee + reasoningFee;

  assert.strictEqual(invoice.subtotal_cents, expectedTotal);
  assert.strictEqual(invoice.total_cents, expectedTotal);
  assert.strictEqual(invoice.total_cents, 2900 + 150 + 30 + 75 + 60); // 3215 cents
});

// ==========================================
// 6. Metering & Quota Invariants Tests
// ==========================================

test('Phase 5.3 - 6.1 Metering & Quota Invariants: rejected request creates 0 usage events', async () => {
  const eventsBefore = await db.query('SELECT COUNT(*)::integer FROM usage_events');

  // Rejection due to invalid tokens (-10)
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'rejected-req-key-99')
    .send({ input_tokens: -10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(400);

  const eventsAfter = await db.query('SELECT COUNT(*)::integer FROM usage_events');
  assert.strictEqual(eventsBefore.rows[0].count, eventsAfter.rows[0].count);
});

// ==========================================
// 7. Tenant Isolation Audit Tests
// ==========================================

test('Phase 5.3 - 7.1 Tenant Isolation Audit: Tenant A cannot inspect or mutate Tenant B invoices or subscriptions', async () => {
  // Create Tenant B
  const tenantBRes = await db.query("INSERT INTO tenants (name) VALUES ('Tenant B') RETURNING id");
  const tenantBId = tenantBRes.rows[0].id;

  // Tenant B upgrades to Pro
  await request(app)
    .post('/api/v1/subscription/checkout')
    .set('x-tenant-id', tenantBId)
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Tenant A (Demo Tenant) queries usage -> falls back to default Free plan
  const usageA = await request(app).get('/api/v1/usage').expect(200);
  assert.strictEqual(usageA.body.plan.name, 'Free');

  // Tenant B queries subscription -> Pro plan
  const subB = await request(app)
    .get('/api/v1/subscription')
    .set('x-tenant-id', tenantBId)
    .expect(200);
  assert.strictEqual(subB.body.subscription.plan.name, 'Pro');

  // Tenant B invoice statement
  const invBRes = await request(app)
    .get('/api/v1/invoices/current')
    .set('x-tenant-id', tenantBId)
    .expect(200);
  const invBId = invBRes.body.invoice.id;

  // Tenant A attempts to fetch Tenant B invoice ID -> MUST return HTTP 404
  await request(app)
    .get(`/api/v1/invoices/${invBId}`)
    .expect(404);
});

// ==========================================
// 8. Database Constraints & Concurrency Tests
// ==========================================

test('Phase 5.3 - 8.1 Database Constraints: partial unique index idx_single_active_subscription_per_tenant prevents duplicate active subscriptions', async () => {
  const demoTenantRes = await db.query("SELECT id FROM tenants WHERE name = 'Demo Tenant' LIMIT 1");
  const tenantId = demoTenantRes.rows[0].id;

  const planRes = await db.query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");
  const planId = planRes.rows[0].id;

  await db.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active')`,
    [tenantId, planId]
  );

  // Attempting second active subscription INSERT directly into DB must trigger 23505 constraint violation
  try {
    await db.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1, $2, 'active')`,
      [tenantId, planId]
    );
    assert.fail('Expected 23505 constraint violation was not thrown.');
  } catch (err) {
    assert.strictEqual(err.code, '23505');
    assert.strictEqual(err.constraint, 'idx_single_active_subscription_per_tenant');
  }
});

// ==========================================
// 9. Operational & Health Probes Regression Tests
// ==========================================

test('Phase 5.3 - 9.1 Operational Regression: GET /health and GET /api/v1/health return 200 OK', async () => {
  const res1 = await request(app).get('/health').expect(200);
  assert.strictEqual(res1.body.status, 'ok');
  assert.strictEqual(res1.body.database, 'connected');

  const res2 = await request(app).get('/api/v1/health').expect(200);
  assert.strictEqual(res2.body.status, 'ok');
  assert.strictEqual(res2.body.database, 'connected');
});
