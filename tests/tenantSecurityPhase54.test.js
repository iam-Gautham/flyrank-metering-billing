const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

// ==========================================
// 1. Authentication Boundary Tests
// ==========================================

test('Phase 5.4 - 1.1 Auth Boundary: invalid Bearer token returns HTTP 401 Unauthorized', async () => {
  const res = await request(app)
    .get('/api/v1/subscription')
    .set('Authorization', 'Bearer invalid-token-value-999')
    .expect(401);

  assert.strictEqual(res.body.error, 'Unauthorized');
  assert.strictEqual(res.body.message, 'Invalid authentication credential or tenant identity.');
});

test('Phase 5.4 - 1.2 Auth Boundary: invalid x-tenant-id header returns HTTP 401 Unauthorized', async () => {
  const res = await request(app)
    .get('/api/v1/usage')
    .set('x-tenant-id', 'nonexistent-tenant-uuid-000')
    .expect(401);

  assert.strictEqual(res.body.error, 'Unauthorized');
});

test('Phase 5.4 - 1.3 Auth Boundary: valid Bearer token resolves tenant identity successfully', async () => {
  const res = await request(app)
    .get('/api/v1/usage')
    .set('Authorization', 'Bearer Demo Tenant')
    .expect(200);

  assert.strictEqual(res.body.tenant.name, 'Demo Tenant');
});

test('Phase 5.4 - 1.4 Auth Boundary: health endpoints remain public (200 OK)', async () => {
  await request(app).get('/health').expect(200);
  await request(app).get('/api/v1/health').expect(200);
});

// ==========================================
// 2. Tenant Authorization & Cross-Tenant Access Tests
// ==========================================

test('Phase 5.4 - 2.1 Tenant Authorization: Tenant A cannot fetch Tenant B invoice by ID', async () => {
  // Create Tenant A & Tenant B
  const resA = await db.query("INSERT INTO tenants (name) VALUES ('Tenant Auth A') RETURNING id");
  const tenantAId = resA.rows[0].id;

  const resB = await db.query("INSERT INTO tenants (name) VALUES ('Tenant Auth B') RETURNING id");
  const tenantBId = resB.rows[0].id;

  // Tenant B upgrades to Pro
  await request(app)
    .post('/api/v1/subscription/checkout')
    .set('x-tenant-id', tenantBId)
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Tenant B gets invoice ID
  const invBRes = await request(app)
    .get('/api/v1/invoices/current')
    .set('x-tenant-id', tenantBId)
    .expect(200);
  const invBId = invBRes.body.invoice.id;

  // Tenant A attempts to fetch Tenant B's invoice ID -> MUST return HTTP 404
  const res404 = await request(app)
    .get(`/api/v1/invoices/${invBId}`)
    .set('x-tenant-id', tenantAId)
    .expect(404);

  assert.strictEqual(res404.body.error, 'Not Found');
});

test('Phase 5.4 - 2.2 Tenant Authorization: Tenant A cannot cancel Tenant B subscription', async () => {
  const dbTenantB = await db.query("INSERT INTO tenants (name) VALUES ('Tenant Mutate B') RETURNING id");
  const tenantBId = dbTenantB.rows[0].id;

  const dbTenantA = await db.query("INSERT INTO tenants (name) VALUES ('Tenant Mutate A') RETURNING id");
  const tenantAId = dbTenantA.rows[0].id;

  // Tenant B creates subscription
  await request(app)
    .post('/api/v1/subscription/checkout')
    .set('x-tenant-id', tenantBId)
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Tenant A attempts cancellation -> Tenant A has no active subscription, returns 404
  await request(app)
    .post('/api/v1/subscription/cancel')
    .set('x-tenant-id', tenantAId)
    .expect(404);

  // Tenant B's subscription remains active
  const subB = await request(app)
    .get('/api/v1/subscription')
    .set('x-tenant-id', tenantBId)
    .expect(200);
  assert.strictEqual(subB.body.subscription.status, 'active');
});

// ==========================================
// 3. Idempotency Security Tests
// ==========================================

test('Phase 5.4 - 3.1 Idempotency Security: same key used by Tenant B does not leak Tenant A cached response', async () => {
  const dbTenantA = await db.query("INSERT INTO tenants (name) VALUES ('Tenant Idem A') RETURNING id");
  const tenantAId = dbTenantA.rows[0].id;

  const dbTenantB = await db.query("INSERT INTO tenants (name) VALUES ('Tenant Idem B') RETURNING id");
  const tenantBId = dbTenantB.rows[0].id;

  const sharedKey = `shared-attack-key-${Date.now()}`;

  // Tenant A executes generation with sharedKey (input_tokens: 50)
  await request(app)
    .post('/api/v1/generate')
    .set('x-tenant-id', tenantAId)
    .set('Idempotency-Key', sharedKey)
    .send({ input_tokens: 50, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);

  // Tenant B executes generation with SAME sharedKey (input_tokens: 200)
  const genResB = await request(app)
    .post('/api/v1/generate')
    .set('x-tenant-id', tenantBId)
    .set('Idempotency-Key', sharedKey)
    .send({ input_tokens: 200, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 })
    .expect(200);

  // Tenant B gets its OWN token count (200), NOT Tenant A's cached response (50)!
  assert.strictEqual(genResB.body.usage.input_tokens, 200);
});

// ==========================================
// 4. Input Validation & SQL Security Tests
// ==========================================

test('Phase 5.4 - 4.1 SQL Injection Protection: malformed tenant header does not cause 500 or SQL error', async () => {
  const injectionHeader = "00000000-0000-0000-0000-000000000000' OR '1'='1";
  
  const res = await request(app)
    .get('/api/v1/usage')
    .set('x-tenant-id', injectionHeader)
    .expect(401);

  assert.strictEqual(res.body.error, 'Unauthorized');
});
