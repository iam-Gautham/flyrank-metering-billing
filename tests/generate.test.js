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

test('POST /api/v1/generate - returns 400 Bad Request when Idempotency-Key header is missing or empty', async () => {
  const requestBody = {
    input_tokens: 100,
    cached_tokens: 20,
    output_tokens: 50,
    reasoning_tokens: 10,
  };

  const res1 = await request(app)
    .post('/api/v1/generate')
    .send(requestBody)
    .expect(400);

  assert.strictEqual(res1.body.error, 'Bad Request');
  assert.match(res1.body.message, /Idempotency-Key/i);

  const res2 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', '  ')
    .send(requestBody)
    .expect(400);

  assert.strictEqual(res2.body.error, 'Bad Request');
});

test('POST /api/v1/generate - returns 400 Bad Request when token values are invalid', async () => {
  const requestBody = {
    input_tokens: -10,
    cached_tokens: 25,
    output_tokens: 'invalid',
    reasoning_tokens: 10,
  };

  const res = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-invalid-tokens')
    .send(requestBody)
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
});

test('POST /api/v1/generate - basic successful request, idempotent duplicate, and different key', async () => {
  const body1 = { input_tokens: 100, cached_tokens: 20, output_tokens: 50, reasoning_tokens: 10 };
  const key1 = 'key-uuid-001';

  // First request
  const res1 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', key1)
    .send(body1)
    .expect(200);

  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.usage.total_tokens, 180);

  // Duplicate request
  const res2 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', key1)
    .send(body1)
    .expect(200);

  assert.strictEqual(res2.body.usage.total_tokens, 180);

  // DB Count check
  const countRes = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countRes.rows[0].count, 10), 1);

  // Different key request
  const key2 = 'key-uuid-002';
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', key2)
    .send(body1)
    .expect(200);

  const countRes2 = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countRes2.rows[0].count, 10), 2);
});

test('POST /api/v1/generate - API Call Quota enforcement (below, exactly at, and exceeding quota)', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);
  const apiLimit = sub.monthly_api_limit; // 1000

  // Batch insert (apiLimit - 2) usage events to reach 998 API calls
  const now = new Date();
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, created_at)
     SELECT $1, 'seed-key-' || g, 'AI_TOKENS', 10, $2
     FROM generate_series(1, $3) AS g`,
    [tenant.id, now, apiLimit - 2]
  );

  const countBefore = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countBefore.rows[0].count, 10), 998);

  // a. Request below API quota (call #999) -> SUCCEEDS
  const resBelow = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-api-999')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(resBelow.body.success, true);

  // b. Request exactly at API quota (call #1000) -> SUCCEEDS
  const resExact = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-api-1000')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(resExact.body.success, true);

  const countAtLimit = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countAtLimit.rows[0].count, 10), 1000);

  // c. Request exceeding API quota (call #1001) -> REJECTED 429
  const resExceed = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-api-1001')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(429);

  assert.strictEqual(resExceed.body.error, 'Too Many Requests');
  assert.strictEqual(resExceed.body.quota_type, 'API_CALLS');
  assert.match(resExceed.body.message, /API call limit exceeded/i);

  // g. Verify rejected request created NO usage event
  const countAfterExceed = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countAfterExceed.rows[0].count, 10), 1000);
});

test('POST /api/v1/generate - AI Token Quota enforcement (below, exactly at, and exceeding quota)', async () => {
  const tenant = await getDemoTenant();
  const sub = await getOrCreateActiveSubscription(tenant.id);
  const tokenLimit = sub.monthly_token_limit; // 100,000

  // Insert existing usage event with 99,500 tokens
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens)
     VALUES ($1, 'seed-tokens-99500', 'AI_TOKENS', 99500, 99500)`,
    [tenant.id]
  );

  // d. Request below token quota (300 tokens -> total 99,800) -> SUCCEEDS
  const resBelow = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-token-below')
    .send({ input_tokens: 300, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(resBelow.body.usage.total_tokens, 300);

  // e. Request exactly at token quota (200 tokens -> total 100,000) -> SUCCEEDS
  const resExact = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-token-exact')
    .send({ input_tokens: 200, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(resExact.body.usage.total_tokens, 200);

  // f. Request exceeding token quota (10 tokens -> total 100,010) -> REJECTED 429
  const resExceed = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-token-exceed')
    .send({ input_tokens: 10, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(429);

  assert.strictEqual(resExceed.body.error, 'Too Many Requests');
  assert.strictEqual(resExceed.body.quota_type, 'AI_TOKENS');
  assert.match(resExceed.body.message, /AI token limit exceeded/i);

  // h. Duplicate idempotent request with an already-completed key STILL returns original result
  const resDup = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'key-token-exact')
    .send({ input_tokens: 200, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);
  assert.strictEqual(resDup.body.usage.total_tokens, 200);

  // g. Verify rejected request created NO usage event (total rows = 3: seed + below + exact)
  const countAfterExceed = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(countAfterExceed.rows[0].count, 10), 3);
});
