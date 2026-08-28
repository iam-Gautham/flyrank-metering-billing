const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  // Clear usage_events before each test for predictable environment state
  await db.query('DELETE FROM usage_events');
});

test('POST /api/v1/generate - returns 400 Bad Request when Idempotency-Key header is missing or empty', async () => {
  const requestBody = {
    input_tokens: 100,
    cached_tokens: 20,
    output_tokens: 50,
    reasoning_tokens: 10,
  };

  // Missing header
  const response1 = await request(app)
    .post('/api/v1/generate')
    .send(requestBody)
    .expect('Content-Type', /json/)
    .expect(400);

  assert.strictEqual(response1.body.error, 'Bad Request');
  assert.match(response1.body.message, /Idempotency-Key/i);

  // Empty header
  const response2 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', '   ')
    .send(requestBody)
    .expect('Content-Type', /json/)
    .expect(400);

  assert.strictEqual(response2.body.error, 'Bad Request');
});

test('POST /api/v1/generate - returns 400 Bad Request when token values are invalid', async () => {
  const requestBody = {
    input_tokens: -10,
    cached_tokens: 25,
    output_tokens: 'invalid',
    reasoning_tokens: 10,
  };

  const response = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'test-key-invalid-tokens')
    .send(requestBody)
    .expect('Content-Type', /json/)
    .expect(400);

  assert.strictEqual(response.body.error, 'Bad Request');
});

test('POST /api/v1/generate - successful first request, idempotent repeat request, and different key request', async () => {
  const requestBody1 = {
    input_tokens: 100,
    cached_tokens: 20,
    output_tokens: 50,
    reasoning_tokens: 10,
  };
  const idempotencyKey1 = 'key-uuid-001';

  // 1. First request with key 1 -> usage event created
  const res1 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', idempotencyKey1)
    .send(requestBody1)
    .expect(200);

  assert.strictEqual(res1.body.success, true);
  assert.strictEqual(res1.body.usage.total_tokens, 180);

  // Verify 1 event in database
  const dbCount1 = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(dbCount1.rows[0].count, 10), 1);

  // 2. Repeat request with same key 1 -> returns stored result, NO additional usage event created
  const res2 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', idempotencyKey1)
    .send(requestBody1)
    .expect(200);

  assert.strictEqual(res2.body.success, true);
  assert.strictEqual(res2.body.usage.total_tokens, 180);

  // Verify database count STILL equals 1
  const dbCount2 = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(dbCount2.rows[0].count, 10), 1);

  // 3. Different request with key 2 -> new usage event created
  const idempotencyKey2 = 'key-uuid-002';
  const requestBody2 = {
    input_tokens: 200,
    cached_tokens: 0,
    output_tokens: 100,
    reasoning_tokens: 0,
  };

  const res3 = await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', idempotencyKey2)
    .send(requestBody2)
    .expect(200);

  assert.strictEqual(res3.body.success, true);
  assert.strictEqual(res3.body.usage.total_tokens, 300);

  // Verify database count is now 2
  const dbCount3 = await db.query('SELECT COUNT(*) FROM usage_events');
  assert.strictEqual(parseInt(dbCount3.rows[0].count, 10), 2);
});
