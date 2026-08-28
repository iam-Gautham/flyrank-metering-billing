const { test, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { startServer } = require('../src/server');

after(async () => {
  await db.pool.end();
});

test('Production Readiness - GET /health returns HTTP 200 OK when database is connected', async () => {
  const res = await request(app)
    .get('/health')
    .expect(200);

  assert.strictEqual(res.body.status, 'ok');
  assert.strictEqual(res.body.database, 'connected');
});

test('Production Readiness - GET /api/v1/health returns HTTP 200 OK when database is connected', async () => {
  const res = await request(app)
    .get('/api/v1/health')
    .expect(200);

  assert.strictEqual(res.body.status, 'ok');
  assert.strictEqual(res.body.database, 'connected');
});

test('Production Readiness - GET /health returns HTTP 503 Service Unavailable when database query fails', async () => {
  const originalQuery = db.query;
  db.query = async () => {
    throw new Error('Database connection failed.');
  };

  try {
    const res = await request(app)
      .get('/health')
      .expect(503);

    assert.strictEqual(res.body.status, 'error');
    assert.strictEqual(res.body.database, 'disconnected');
  } finally {
    db.query = originalQuery;
  }
});

test('Production Readiness - API body payload exceeding 1MB limit returns HTTP 413 Payload Too Large', async () => {
  const largePayload = 'A'.repeat(1024 * 1024 + 100);

  const res = await request(app)
    .post('/api/v1/subscription/checkout')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ plan_name: largePayload }))
    .expect(413);

  assert.strictEqual(res.body.error, 'Payload Too Large');
  assert.strictEqual(res.body.message.includes('1MB'), true);
});

test('Production Readiness - startServer verifies database connectivity before starting', async () => {
  const originalQuery = db.query;
  let connectivityChecked = false;

  db.query = async (text) => {
    if (text === 'SELECT 1') {
      connectivityChecked = true;
      return { rows: [{ '?column?': 1 }] };
    }
    return originalQuery(text);
  };

  try {
    const testServer = await startServer();
    assert.strictEqual(connectivityChecked, true);
    assert.ok(testServer);
    await new Promise((resolve) => testServer.close(resolve));
  } finally {
    db.query = originalQuery;
  }
});
