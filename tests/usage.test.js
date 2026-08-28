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

test('GET /api/v1/usage - returns zero usage for a clean tenant', async () => {
  const res = await request(app)
    .get('/api/v1/usage')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.ok(res.body.tenant);
  assert.strictEqual(res.body.tenant.name, 'Demo Tenant');
  assert.strictEqual(res.body.plan.name, 'Free');
  assert.strictEqual(res.body.usage.api_calls.used, 0);
  assert.strictEqual(res.body.usage.api_calls.limit, 1000);
  assert.strictEqual(res.body.usage.api_calls.remaining, 1000);
  assert.strictEqual(res.body.usage.ai_tokens.used, 0);
  assert.strictEqual(res.body.usage.ai_tokens.limit, 100000);
  assert.strictEqual(res.body.usage.ai_tokens.remaining, 100000);
});

test('GET /api/v1/usage - calculates API_CALL and AI_TOKENS usage and remaining quotas correctly', async () => {
  const tenant = await getDemoTenant();
  await getOrCreateActiveSubscription(tenant.id);

  const now = new Date();

  // Insert 2 distinct API_CALL events
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'key-api-1', 'API_CALL', 1, $2),
            ($1, 'key-api-2', 'API_CALL', 1, $2)`,
    [tenant.id, now]
  );

  // Insert 1 AI_TOKENS event with 15,000 tokens
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, output_tokens, created_at)
     VALUES ($1, 'key-tokens-1', 'AI_TOKENS', 15000, 10000, 5000, $2)`,
    [tenant.id, now]
  );

  const res = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  // Exactly 2 API_CALL events = 2 API calls used
  assert.strictEqual(res.body.usage.api_calls.used, 2);
  assert.strictEqual(res.body.usage.api_calls.limit, 1000);
  assert.strictEqual(res.body.usage.api_calls.remaining, 998);

  // Exactly 15,000 AI tokens used
  assert.strictEqual(res.body.usage.ai_tokens.used, 15000);
  assert.strictEqual(res.body.usage.ai_tokens.limit, 100000);
  assert.strictEqual(res.body.usage.ai_tokens.remaining, 85000);
});

test('GET /api/v1/usage - excludes usage events outside the current billing period', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);

  const periodStart = new Date(sub.current_period_start);
  const periodEnd = new Date(sub.current_period_end);

  // Past event (1 month before current period)
  const pastDate = new Date(periodStart.getTime() - 1000 * 60 * 60 * 24 * 35);
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'past-event-1:api', 'API_CALL', 1, $2),
            ($1, 'past-event-1:tokens', 'AI_TOKENS', 50000, $2)`,
    [tenant.id, pastDate]
  );

  // Future event (1 month after current period)
  const futureDate = new Date(periodEnd.getTime() + 1000 * 60 * 60 * 24 * 5);
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'future-event-1:api', 'API_CALL', 1, $2),
            ($1, 'future-event-1:tokens', 'AI_TOKENS', 50000, $2)`,
    [tenant.id, futureDate]
  );

  // Current period event (10,000 tokens + 1 API call)
  const currentDate = new Date(periodStart.getTime() + 1000 * 60 * 60 * 24 * 2);
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     VALUES ($1, 'current-event-1:api', 'API_CALL', 1, $2),
            ($1, 'current-event-1:tokens', 'AI_TOKENS', 10000, $2)`,
    [tenant.id, currentDate]
  );

  const res = await request(app)
    .get('/api/v1/usage')
    .expect(200);

  // Only current period events are counted
  assert.strictEqual(res.body.usage.api_calls.used, 1);
  assert.strictEqual(res.body.usage.ai_tokens.used, 10000);
  assert.strictEqual(res.body.usage.ai_tokens.remaining, 90000);
});

test('GET /api/v1/usage - does not create or modify usage events (read-only)', async () => {
  const countBefore = await db.query('SELECT COUNT(*) FROM usage_events');
  
  await request(app)
    .get('/api/v1/usage')
    .expect(200);

  const countAfter = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(countAfter.rows[0].count, countBefore.rows[0].count);
});
