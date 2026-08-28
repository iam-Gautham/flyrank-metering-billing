const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { validateConfig } = require('../src/config');
const { reconcileTenantSubscription } = require('../src/services/reconciliationService');
const logger = require('../src/utils/logger');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

// ==========================================
// 1. Configuration Safety & Validation Tests
// ==========================================

test('Phase 6.1 - 1.1 Config Validation: rejects invalid PORT setting', () => {
  const origPort = process.env.PORT;
  try {
    process.env.PORT = '999999';
    assert.throws(() => validateConfig(), /Invalid PORT configuration/);
  } finally {
    if (origPort !== undefined) {
      process.env.PORT = origPort;
    } else {
      delete process.env.PORT;
    }
  }
});

test('Phase 6.1 - 1.2 Config Validation: rejects invalid DB_POOL_MAX setting', () => {
  const origPool = process.env.DB_POOL_MAX;
  try {
    process.env.DB_POOL_MAX = '-5';
    assert.throws(() => validateConfig(), /Invalid DB_POOL_MAX configuration/);
  } finally {
    if (origPool !== undefined) {
      process.env.DB_POOL_MAX = origPool;
    } else {
      delete process.env.DB_POOL_MAX;
    }
  }
});

test('Phase 6.1 - 1.3 Config Validation: resolves valid configuration', () => {
  const config = validateConfig();
  assert.ok(config.port > 0);
  assert.ok(config.db.poolMax > 0);
});

// ==========================================
// 2. Health, Liveness & Readiness Tests
// ==========================================

test('Phase 6.1 - 2.1 Health Probes: GET /health/liveness returns 200 OK without DB dependency', async () => {
  const res = await request(app).get('/health/liveness').expect(200);
  assert.strictEqual(res.body.status, 'ok');
  assert.strictEqual(res.body.liveness, 'alive');
});

test('Phase 6.1 - 2.2 Health Probes: GET /health/readiness returns 503 when DB query fails', async () => {
  const originalQuery = db.query;
  db.query = async (text, params) => {
    if (text === 'SELECT 1') throw new Error('Database unreachable');
    return originalQuery.call(db, text, params);
  };

  try {
    const res = await request(app).get('/health/readiness').expect(503);
    assert.strictEqual(res.body.status, 'error');
    assert.strictEqual(res.body.readiness, 'not_ready');
  } finally {
    db.query = originalQuery;
  }
});

// ==========================================
// 3. Subscription State Reconciliation Tests
// ==========================================

test('Phase 6.1 - 3.1 Reconciliation: consistent subscription state returns consistent status', async () => {
  const demoTenantRes = await db.query("SELECT id FROM tenants WHERE name = 'Demo Tenant' LIMIT 1");
  const tenantId = demoTenantRes.rows[0].id;

  const result = await reconcileTenantSubscription(tenantId);
  assert.strictEqual(result.status, 'consistent');
  assert.strictEqual(result.updated, false);
});

test('Phase 6.1 - 3.2 Reconciliation: POST /api/v1/subscription/reconcile triggers reconciliation endpoint', async () => {
  const res = await request(app)
    .post('/api/v1/subscription/reconcile')
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.reconciliation);
});

// ==========================================
// 4. Operational Logger Secret Redaction Tests
// ==========================================

test('Phase 6.1 - 4.1 Log Safety: logger.redactObject redacts sensitive credentials and tokens', () => {
  const sensitiveMeta = {
    user: 'demo_user',
    password: 'super_secret_password',
    api_key: 'sk_live_12345',
    nested: {
      token: 'bearer_token_xyz',
      normal_field: 'public_value',
    },
  };

  const redacted = logger.redactObject(sensitiveMeta);

  assert.strictEqual(redacted.user, 'demo_user');
  assert.strictEqual(redacted.password, '[REDACTED]');
  assert.strictEqual(redacted.api_key, '[REDACTED]');
  assert.strictEqual(redacted.nested.token, '[REDACTED]');
  assert.strictEqual(redacted.nested.normal_field, 'public_value');
});

// ==========================================
// 5. Graceful Shutdown Guard Middleware Tests
// ==========================================

test('Phase 6.1 - 5.1 Shutdown Guard: rejects incoming HTTP traffic with HTTP 503 during shutdown', async () => {
  app.setShuttingDown(true);
  try {
    const res = await request(app).get('/api/v1/usage').expect(503);
    assert.strictEqual(res.body.error, 'Service Unavailable');
  } finally {
    app.setShuttingDown(false);
  }
});
