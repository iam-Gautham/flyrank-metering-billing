const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { getDemoTenant } = require('../src/services/tenantService');
const { getOrCreateActiveSubscription } = require('../src/services/subscriptionService');
const { checkAndRecordUsageTransaction } = require('../src/services/quotaService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

// Scenario A: Clean tenant request sequence, usage, cost, and idempotent repeat
test('Scenario A - clean tenant request sequence, usage, cost calculation, and idempotent repeat', async () => {
  const idempotencyKey = 'scenario-a-key-001';
  const body = {
    input_tokens: 50000,
    cached_tokens: 20000,
    output_tokens: 10000,
    reasoning_tokens: 5000,
  };

  // 1. Send initial request
  const res1 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', idempotencyKey)
    .send(body)
    .expect(200);

  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.usage.total_tokens, 85000);

  // Verify DB record and cost_cents computation (47 cents)
  const dbEvents1 = await db.query('SELECT * FROM usage_events WHERE idempotency_key = $1', [idempotencyKey]);
  assert.strictEqual(dbEvents1.rows.length, 1);
  assert.strictEqual(dbEvents1.rows[0].quantity, 85000);
  assert.strictEqual(dbEvents1.rows[0].cost_cents, 47);

  // 2. Repeat request with same idempotency key
  const res2 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', idempotencyKey)
    .send(body)
    .expect(200);

  assert.strictEqual(res2.body.usage.total_tokens, 85000);

  // Verify usage events count did NOT increase
  const dbEventsCount = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(dbEventsCount.rows[0].count, 10), 1);
});

// Scenario B: API Quota boundary and 429 rejection with zero usage event creation
test('Scenario B - API quota boundary enforcement and 429 rejection without creating usage events', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);
  const apiLimit = sub.monthly_api_limit; // 1000

  // Seed 999 API calls
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     SELECT $1, 'scenario-b-key-' || g, 'AI_TOKENS', 10, NOW()
     FROM generate_series(1, $2) AS g`,
    [tenant.id, apiLimit - 1]
  );

  // 1000th call (exactly at limit) -> SUCCEEDS
  const res1000 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-b-key-1000')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(res1000.body.success, true);

  // 1001st call (exceeding limit) -> REJECTED HTTP 429
  const res1001 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-b-key-1001')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(429);

  assert.strictEqual(res1001.body.error, 'Too Many Requests');
  assert.strictEqual(res1001.body.quota_type, 'API_CALLS');

  // Verify rejected request created NO usage event (total count remains 1000)
  const countRes = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 1000);
});

// Scenario C: AI Token Quota boundary and 429 rejection
test('Scenario C - AI token quota boundary and 429 rejection', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);
  const tokenLimit = sub.monthly_token_limit; // 100000

  // Seed 99,000 tokens
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens)
     VALUES ($1, 'scenario-c-seed', 'AI_TOKENS', 99000, 99000)`,
    [tenant.id]
  );

  // Request 1000 tokens -> Total 100,000 (exactly at limit) -> SUCCEEDS
  const resExact = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-c-exact')
    .send({ input_tokens: 1000, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(resExact.body.usage.total_tokens, 1000);

  // Request 1 token -> Total 100,001 (exceeding limit) -> REJECTED HTTP 429
  const resExceed = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'scenario-c-exceed')
    .send({ input_tokens: 1, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(429);

  assert.strictEqual(resExceed.body.error, 'Too Many Requests');
  assert.strictEqual(resExceed.body.quota_type, 'AI_TOKENS');

  // Verify rejected request created NO usage event (count remains 2)
  const countRes = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 2);
});

// Scenario D: Concurrent requests using DIFFERENT idempotency keys
test('Scenario D - concurrent requests with different idempotency keys are handled safely under quota locking', async () => {
  const body = { input_tokens: 100, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };

  const [res1, res2] = await Promise.all([
    request(app).post('/api/v1/generate').set('Idempotency-Key', 'concurrent-diff-key-1').send(body),
    request(app).post('/api/v1/generate').set('Idempotency-Key', 'concurrent-diff-key-2').send(body),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);

  // Verify 2 usage events recorded in DB
  const countRes = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 2);
});

// Scenario E: Concurrent requests using the SAME idempotency key
test('Scenario E - concurrent requests with the SAME idempotency key create only ONE usage event', async () => {
  const sameKey = 'concurrent-same-key-001';
  const body = { input_tokens: 200, cached_tokens: 50, output_tokens: 50, reasoning_tokens: 0 };

  const [res1, res2] = await Promise.all([
    request(app).post('/api/v1/generate').set('Idempotency-Key', sameKey).send(body),
    request(app).post('/api/v1/generate').set('Idempotency-Key', sameKey).send(body),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res1.body.usage.total_tokens, 300);
  assert.strictEqual(res2.body.usage.total_tokens, 300);

  // Verify EXACTLY 1 usage event recorded in DB
  const countRes = await db.query('SELECT COUNT(*) FROM usage_events WHERE idempotency_key = $1', [sameKey]);
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 1);
});

// Transaction Rollback Safety: verify failed operations roll back without partial commits
test('Transaction Rollback Safety - failed transaction rolls back cleanly without partial quota state commit', async () => {
  const tenant = await getDemoTenant();
  const countBefore = await db.query('SELECT COUNT(*) FROM usage_events');

  try {
    // Force a database error inside transaction by passing invalid parameters to DB query
    await checkAndRecordUsageTransaction({
      tenantId: tenant.id,
      idempotencyKey: 'rollback-test-key',
      usageType: 'AI_TOKENS',
      quantity: -100, // Invalid quantity violating CHECK (quantity >= 0) constraint
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costCents: 0,
    });
    assert.fail('Expected checkAndRecordUsageTransaction to throw database constraint error');
  } catch (err) {
    assert.ok(err);
  }

  // Verify DB count remains unchanged (clean rollback)
  const countAfter = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(countAfter.rows[0].count, countBefore.rows[0].count);
});

// Tenant-Scoped Idempotency: same key allowed across different tenants
test('Tenant-Scoped Idempotency - same idempotency key is allowed for different tenants', async () => {
  const sharedKey = 'shared-cross-tenant-key';

  // 1. Create a second tenant in DB
  const tenant2Res = await db.query("INSERT INTO tenants (name) VALUES ('Second Tenant') RETURNING *");
  const tenant2 = tenant2Res.rows[0];

  const demoTenant = await getDemoTenant();

  // Insert usage event for Demo Tenant with sharedKey
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity)
     VALUES ($1, $2, 'AI_TOKENS', 100)`,
    [demoTenant.id, sharedKey]
  );

  // Insert usage event for Second Tenant with SAME sharedKey -> Must succeed without UNIQUE violation
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity)
     VALUES ($1, $2, 'AI_TOKENS', 200)`,
    [tenant2.id, sharedKey]
  );

  const sharedKeyEvents = await db.query('SELECT * FROM usage_events WHERE idempotency_key = $1', [sharedKey]);
  assert.strictEqual(sharedKeyEvents.rows.length, 2);
});
