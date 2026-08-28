const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { getDemoTenant } = require('../src/services/tenantService');
const { getOrCreateActiveSubscription } = require('../src/services/subscriptionService');
const { processWebhookEvent } = require('../src/services/webhookService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('POST /api/v1/webhooks/payment - returns 400 for invalid webhook payload structure', async () => {
  // Invalid body (missing id)
  const res1 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ type: 'subscription.updated', data: { subscription_id: 'sub_123' } })
    .expect(400);

  assert.strictEqual(res1.body.error, 'Bad Request');
  assert.match(res1.body.message, /valid id/i);

  // Missing data object
  const res2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ id: 'evt_001', type: 'subscription.updated' })
    .expect(400);

  assert.strictEqual(res2.body.error, 'Bad Request');

  // Missing subscription_id inside data
  const res3 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({ id: 'evt_001', type: 'subscription.updated', data: {} })
    .expect(400);

  assert.strictEqual(res3.body.error, 'Bad Request');
});

test('POST /api/v1/webhooks/payment - returns 400 for unknown event type', async () => {
  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_unknown_001',
      type: 'unsupported.event.type',
      data: { subscription_id: 'sub_123' },
    })
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
  assert.match(res.body.message, /Unsupported event type/i);
});

test('POST /api/v1/webhooks/payment - returns 404 for unknown subscription ID without corrupting data', async () => {
  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_nonexistent_001',
      type: 'subscription.updated',
      data: { subscription_id: 'fake_sub_nonexistent' },
    })
    .expect(404);

  assert.strictEqual(res.body.error, 'Not Found');
  assert.match(res.body.message, /Subscription 'fake_sub_nonexistent' not found/i);
});

test('POST /api/v1/webhooks/payment - subscription.created event creates/activates subscription and handles duplicates idempotently', async () => {
  const tenant = await getDemoTenant();

  // Create initial subscription with custom provider ID
  const providerSubId = 'fake_sub_created_test_001';
  const freePlanRes = await db.query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");
  const freePlanId = freePlanRes.rows[0].id;

  await db.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id)
     VALUES ($1, $2, 'inactive', $3)`,
    [tenant.id, freePlanId, providerSubId]
  );

  const eventPayload = {
    id: 'evt_created_001',
    type: 'subscription.created',
    data: {
      subscription_id: providerSubId,
      status: 'active',
      plan_name: 'Pro',
    },
  };

  // 1. First event call -> Activates subscription and updates to Pro
  const res1 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);

  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.status, 'active');

  const sub1 = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.stripe_subscription_id = $1",
    [providerSubId]
  );
  assert.strictEqual(sub1.rows[0].status, 'active');
  assert.strictEqual(sub1.rows[0].plan_name, 'Pro');

  // 2. Duplicate event call -> Idempotent response with 0 extra side effects
  const res2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);

  assert.strictEqual(res2.body.idempotent, true);

  const subCount = await db.query("SELECT COUNT(*) FROM subscriptions WHERE stripe_subscription_id = $1", [providerSubId]);
  assert.strictEqual(parseInt(subCount.rows[0].count, 10), 1);
});

test('POST /api/v1/webhooks/payment - subscription.updated event updates status & plan, duplicate is idempotent', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  // Set provider subscription ID
  const providerSubId = 'fake_sub_updated_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const eventPayload = {
    id: 'evt_updated_001',
    type: 'subscription.updated',
    data: {
      subscription_id: providerSubId,
      status: 'active',
      plan_name: 'Pro',
    },
  };

  // 1. Process subscription.updated
  const res1 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);

  assert.strictEqual(res1.body.success, true);

  const updatedSub = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.id = $1",
    [sub.id]
  );
  assert.strictEqual(updatedSub.rows[0].plan_name, 'Pro');

  // 2. Repeat exact same event -> Idempotent
  const res2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);

  assert.strictEqual(res2.body.idempotent, true);
});

test('POST /api/v1/webhooks/payment - subscription.cancelled event sets status to canceled, retains row, duplicate is idempotent', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_cancel_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const eventPayload = {
    id: 'evt_cancel_001',
    type: 'subscription.cancelled',
    data: {
      subscription_id: providerSubId,
    },
  };

  // 1. Process subscription.cancelled
  const res1 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);

  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.status, 'canceled');

  // Verify row still exists in DB with status = 'canceled'
  const dbSub = await db.query('SELECT * FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSub.rows.length, 1);
  assert.strictEqual(dbSub.rows[0].status, 'canceled');

  // 2. Duplicate cancellation event -> Idempotent, remains canceled
  const res2 = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(eventPayload)
    .expect(200);

  assert.strictEqual(res2.body.idempotent, true);
  const dbSubAfterDup = await db.query('SELECT * FROM subscriptions WHERE id = $1', [sub.id]);
  assert.strictEqual(dbSubAfterDup.rows[0].status, 'canceled');
});

test('POST /api/v1/webhooks/payment - concurrent duplicate webhook delivery protection', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_concurrent_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const sameEvent = {
    id: 'evt_concurrent_001',
    type: 'subscription.updated',
    data: {
      subscription_id: providerSubId,
      status: 'active',
      plan_name: 'Pro',
    },
  };

  // Fire concurrent requests simultaneously via Promise.all
  const [res1, res2] = await Promise.all([
    request(app).post('/api/v1/webhooks/payment').send(sameEvent),
    request(app).post('/api/v1/webhooks/payment').send(sameEvent),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);

  // Exactly 1 webhook event marker stored in usage_events
  const markerCount = await db.query("SELECT COUNT(*) FROM usage_events WHERE idempotency_key = 'webhook:evt_concurrent_001'");
  assert.strictEqual(parseInt(markerCount.rows[0].count, 10), 1);
});

test('POST /api/v1/webhooks/payment - out-of-order and stale event protection', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_ooo_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const baseTime = Math.floor(Date.now() / 1000);

  // 1. Process NEWER event (created = baseTime + 200) updating plan to Pro
  const newerEvent = {
    id: 'evt_newer_200',
    type: 'subscription.updated',
    created: baseTime + 200,
    data: {
      subscription_id: providerSubId,
      status: 'active',
      plan_name: 'Pro',
    },
  };

  const resNewer = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(newerEvent)
    .expect(200);

  assert.strictEqual(resNewer.body.success, true);
  assert.strictEqual(resNewer.body.status, 'active');

  // Verify DB plan is Pro
  const dbSub1 = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.id = $1",
    [sub.id]
  );
  assert.strictEqual(dbSub1.rows[0].plan_name, 'Pro');

  // 2. Process STALE / OLDER event (created = baseTime + 100) attempting to set plan back to Free
  const olderEvent = {
    id: 'evt_older_100',
    type: 'subscription.updated',
    created: baseTime + 100,
    data: {
      subscription_id: providerSubId,
      status: 'active',
      plan_name: 'Free',
    },
  };

  const resOlder = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(olderEvent)
    .expect(200);

  assert.strictEqual(resOlder.body.stale, true);
  assert.match(resOlder.body.message, /stale\/out-of-order/i);

  // Verify PostgreSQL subscription plan remains 'Pro' (unmodified by stale event)
  const dbSub2 = await db.query(
    "SELECT s.*, p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.id = $1",
    [sub.id]
  );
  assert.strictEqual(dbSub2.rows[0].plan_name, 'Pro');
});

test('POST /api/v1/webhooks/payment - transaction rollback safety on processing failure', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const providerSubId = 'fake_sub_rollback_test_001';
  await db.query('UPDATE subscriptions SET stripe_subscription_id = $1 WHERE id = $2', [providerSubId, sub.id]);

  const countBefore = await db.query('SELECT COUNT(*) FROM usage_events');

  // Send webhook targeting valid subscription but specifying non-existent plan_name
  const invalidPlanEvent = {
    id: 'evt_invalid_plan_001',
    type: 'subscription.updated',
    data: {
      subscription_id: providerSubId,
      plan_name: 'NonExistentPlanName123',
    },
  };

  const res = await request(app)
    .post('/api/v1/webhooks/payment')
    .send(invalidPlanEvent)
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');

  // Verify database count is unchanged (clean transaction rollback)
  const countAfter = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(countAfter.rows[0].count, countBefore.rows[0].count);
});

test('POST /api/v1/webhooks/payment - tenant/subscription-scoped isolation guarantee', async () => {
  // 1. Create Tenant A and Tenant B with active subscriptions
  const tenantARes = await db.query("INSERT INTO tenants (name) VALUES ('Tenant A') RETURNING *");
  const tenantBRes = await db.query("INSERT INTO tenants (name) VALUES ('Tenant B') RETURNING *");
  const tenantA = tenantARes.rows[0];
  const tenantB = tenantBRes.rows[0];

  const freePlanRes = await db.query("SELECT id FROM plans WHERE name = 'Free' LIMIT 1");
  const freePlanId = freePlanRes.rows[0].id;

  await db.query(
    "INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id) VALUES ($1, $2, 'active', 'sub_tenant_a')",
    [tenantA.id, freePlanId]
  );
  await db.query(
    "INSERT INTO subscriptions (tenant_id, plan_id, status, stripe_subscription_id) VALUES ($1, $2, 'active', 'sub_tenant_b')",
    [tenantB.id, freePlanId]
  );

  // 2. Send webhook targetting Tenant A's subscription only
  await request(app)
    .post('/api/v1/webhooks/payment')
    .send({
      id: 'evt_tenant_a_cancel',
      type: 'subscription.cancelled',
      data: { subscription_id: 'sub_tenant_a' },
    })
    .expect(200);

  // 3. Verify Tenant A is canceled but Tenant B remains active
  const subA = await db.query("SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_tenant_a'");
  const subB = await db.query("SELECT status FROM subscriptions WHERE stripe_subscription_id = 'sub_tenant_b'");

  assert.strictEqual(subA.rows[0].status, 'canceled');
  assert.strictEqual(subB.rows[0].status, 'active');
});
