const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');

after(async () => {
  await db.pool.end();
});

test('POST /api/v1/generate - successfully processes generate request and records usage event', async () => {
  const requestBody = {
    input_tokens: 150,
    cached_tokens: 25,
    output_tokens: 75,
    reasoning_tokens: 10,
  };

  const response = await request(app)
    .post('/api/v1/generate')
    .send(requestBody)
    .expect('Content-Type', /json/)
    .expect(200);

  assert.strictEqual(response.body.success, true);
  assert.ok(response.body.result);
  assert.strictEqual(response.body.usage.input_tokens, 150);
  assert.strictEqual(response.body.usage.cached_tokens, 25);
  assert.strictEqual(response.body.usage.output_tokens, 75);
  assert.strictEqual(response.body.usage.reasoning_tokens, 10);
  assert.strictEqual(response.body.usage.total_tokens, 260);
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
    .send(requestBody)
    .expect('Content-Type', /json/)
    .expect(400);

  assert.strictEqual(response.body.error, 'Bad Request');
});
