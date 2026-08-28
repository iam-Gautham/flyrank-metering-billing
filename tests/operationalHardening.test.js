const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');

after(async () => {
  await db.pool.end();
});

test('Operational Hardening - malformed JSON body returns HTTP 400 Bad Request', async () => {
  const res = await request(app)
    .post('/api/v1/subscription/checkout')
    .set('Content-Type', 'application/json')
    .send('{ "plan_name": }') // Malformed JSON string
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
  assert.strictEqual(res.body.message, 'Invalid JSON payload format.');
});

test('Operational Hardening - internal server error returns sanitized HTTP 500 response without leaking stack traces or DB details', async () => {
  // Mock db.query to throw internal database connection error
  const originalQuery = db.query;
  db.query = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5432 - SELECT * FROM internal_secret_table');
  };

  try {
    const res = await request(app)
      .get('/api/v1/usage')
      .expect(500);

    assert.strictEqual(res.body.error, 'Internal Server Error');
    assert.strictEqual(res.body.message, 'An unexpected internal server error occurred.');
    assert.strictEqual(res.body.stack, undefined);
    assert.strictEqual(res.body.message.includes('ECONNREFUSED'), false);
    assert.strictEqual(res.body.message.includes('internal_secret_table'), false);
  } finally {
    db.query = originalQuery;
  }
});

test('Operational Hardening - plan_name length exceeding 100 characters returns HTTP 400 Bad Request', async () => {
  const longPlanName = 'A'.repeat(101);
  const res = await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: longPlanName })
    .expect(400);

  assert.strictEqual(res.body.error, 'Bad Request');
  assert.strictEqual(res.body.message, 'plan_name exceeds maximum length of 100 characters.');
});
