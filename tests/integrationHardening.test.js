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

test('Scenario A - Free -> Generate -> Upgrade Pro -> Verify Higher Quota -> Generate Again', async () => {
  const tenant = await getDemoTenant();

  // 1. Initial Free subscription
  await getOrCreateActiveSubscription(tenant.id);

  // Generate request consuming 80,000 tokens (Free limit = 100,000)
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-a-key-1')
    .send({ input_tokens: 40000, cached_tokens: 0, output_tokens: 40000, reasoning_tokens: 0 })
    .expect(200);

  // Next request for 30,000 tokens would exceed Free limit (80,000 + 30,000 = 110,000 > 100,000) -> 429
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-a-key-2')
    .send({ input_tokens: 15000, cached_tokens: 0, output_tokens: 15000, reasoning_tokens: 0 })
    .expect(429);

  // 2. Upgrade to Pro via checkout (Pro limit = 5,000,000)
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // 3. Generate request for 30,000 tokens now succeeds immediately under Pro limits!
  const resProGen = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-a-key-3')
    .send({ input_tokens: 15000, cached_tokens: 0, output_tokens: 15000, reasoning_tokens: 0 })
    .expect(200);

  assert.strictEqual(resProGen.body.success, true);
  assert.strictEqual(resProGen.body.usage.total_tokens, 30000);

  // Verify usage summary under Pro plan
  const usageRes = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  assert.strictEqual(usageRes.body.plan.name, 'Pro');
  assert.strictEqual(usageRes.body.usage.ai_tokens.used, 110000);
  assert.strictEqual(usageRes.body.usage.ai_tokens.limit, 5000000);
});

test('Scenario B - Pro -> Generate -> Downgrade Free -> Free Limits Immediately Enforced', async () => {
  const tenant = await getDemoTenant();

  // 1. Start on Pro plan via checkout
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Generate request consuming 150,000 tokens (allowed under Pro limit of 5,000,000)
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-b-key-1')
    .send({ input_tokens: 75000, cached_tokens: 0, output_tokens: 75000, reasoning_tokens: 0 })
    .expect(200);

  // 2. Downgrade to Free plan via checkout
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Free' })
    .expect(200);

  // 3. Subsequent generate request is immediately rejected with 429 because 150,000 > Free limit of 100,000
  const resDowngraded = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-b-key-2')
    .send({ input_tokens: 100, cached_tokens: 0, output_tokens: 100, reasoning_tokens: 0 })
    .expect(429);

  assert.strictEqual(resDowngraded.body.quota_type, 'AI_TOKENS');
});

test('Scenario C - Active Subscription -> Cancel -> Fallback to Free -> Generate Request', async () => {
  const tenant = await getDemoTenant();

  // Start on Pro plan
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Cancel subscription
  await request(app)
    .post('/api/v1/subscription/cancel')
    .expect(200);

  // Generate request succeeds under Free plan fallback logic
  const genRes = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-c-key-1')
    .send({ input_tokens: 500, cached_tokens: 0, output_tokens: 500, reasoning_tokens: 0 })
    .expect(200);

  assert.strictEqual(genRes.body.success, true);
  assert.strictEqual(genRes.body.usage.total_tokens, 1000);
});

test('Scenario D - Subscription Renewal / Month Transition -> Previous-Period Usage Does Not Count', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  // Insert usage event in PREVIOUS calendar month
  const prevMonthDate = new Date();
  prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);

  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, output_tokens, created_at)
     VALUES ($1, 'prev-month-tokens', 'AI_TOKENS', 99000, 49500, 49500, $2)`,
    [tenant.id, prevMonthDate]
  );
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'prev-month-api', 'API_CALL', 1, $2)`,
    [tenant.id, prevMonthDate]
  );

  // Current month usage query should report 0 used tokens
  const usageRes = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  assert.strictEqual(usageRes.body.usage.ai_tokens.used, 0);
  assert.strictEqual(usageRes.body.usage.api_calls.used, 0);

  // New generate request for 50,000 tokens succeeds because previous month usage does not count
  const genRes = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-d-key-1')
    .send({ input_tokens: 25000, cached_tokens: 0, output_tokens: 25000, reasoning_tokens: 0 })
    .expect(200);

  assert.strictEqual(genRes.body.success, true);
  assert.strictEqual(genRes.body.usage.total_tokens, 50000);
});

test('Pricing & Zero-Token Integration - handles zero-token request and integer monetary arithmetic', async () => {
  const tenant = await getDemoTenant();

  // Zero-token generate request
  const zeroRes = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'zero-token-key-1')
    .send({ input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);

  assert.strictEqual(zeroRes.body.usage.total_tokens, 0);

  // Verify DB events: API_CALL cost = 0, AI_TOKENS cost = 0
  const events = await db.query("SELECT usage_type, quantity, cost_cents FROM usage_events WHERE tenant_id = $1", [tenant.id]);
  const apiEvent = events.rows.find((e) => e.usage_type === 'API_CALL');
  const tokensEvent = events.rows.find((e) => e.usage_type === 'AI_TOKENS');

  assert.strictEqual(apiEvent.quantity, 1);
  assert.strictEqual(apiEvent.cost_cents, 0);
  assert.strictEqual(tokensEvent.quantity, 0);
  assert.strictEqual(tokensEvent.cost_cents, 0);
});

test('Concurrency Protection - parallel requests near quota boundary prevent quota oversubscription', async () => {
  const tenant = await getDemoTenant();
  await getOrCreateActiveSubscription(tenant.id);

  // Seed usage to 950 API calls (Free limit = 1,000)
  for (let i = 0; i < 950; i++) {
    await db.query(
      `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity)
       VALUES ($1, $2, 'API_CALL', 1)`,
      [tenant.id, `seed-api-${i}`]
    );
  }

  // Fire 60 concurrent generate requests (each takes 1 API call slot)
  const reqs = Array.from({ length: 60 }, (_, i) =>
    request(app)
      .post('/api/v1/generate')
      .set('Idempotency-Key', `concurrent-quota-key-${i}`)
      .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 10, reasoning_tokens: 0 })
  );

  const results = await Promise.all(reqs);

  const successCount = results.filter((r) => r.status === 200).length;
  const quotaExceededCount = results.filter((r) => r.status === 429).length;

  assert.strictEqual(successCount, 50); // Exactly 50 slots remaining up to 1,000 limit
  assert.strictEqual(quotaExceededCount, 10);

  // Verify DB total API calls is EXACTLY 1,000 (no oversubscription)
  const countRes = await db.query("SELECT COUNT(*) FROM usage_events WHERE tenant_id = $1 AND usage_type = 'API_CALL'", [tenant.id]);
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 1000);
});

test('Multi-Tenant Isolation - same idempotency key is safe across distinct tenants', async () => {
  const tenantARes = await db.query("INSERT INTO tenants (name) VALUES ('Isolated Tenant A') RETURNING *");
  const tenantBRes = await db.query("INSERT INTO tenants (name) VALUES ('Isolated Tenant B') RETURNING *");
  const tenantA = tenantARes.rows[0];
  const tenantB = tenantBRes.rows[0];

  await getOrCreateActiveSubscription(tenantA.id);
  await getOrCreateActiveSubscription(tenantB.id);

  const sharedIdempotencyKey = 'shared-cross-tenant-key-001';

  // Seed usage event for Tenant A using shared key
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity)
     VALUES ($1, $2, 'API_CALL', 1)`,
    [tenantA.id, sharedIdempotencyKey]
  );

  // Tenant B can insert usage event with the exact same idempotency key without collision
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity)
     VALUES ($1, $2, 'API_CALL', 1)`,
    [tenantB.id, sharedIdempotencyKey]
  );

  const countA = await db.query("SELECT COUNT(*) FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2", [tenantA.id, sharedIdempotencyKey]);
  const countB = await db.query("SELECT COUNT(*) FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2", [tenantB.id, sharedIdempotencyKey]);

  assert.strictEqual(parseInt(countA.rows[0].count, 10), 1);
  assert.strictEqual(parseInt(countB.rows[0].count, 10), 1);
});
