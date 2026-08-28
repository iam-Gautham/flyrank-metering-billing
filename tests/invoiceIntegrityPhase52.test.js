const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db');
const { calculateTokenCost } = require('../src/services/pricingService');

after(async () => {
  await db.pool.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM webhook_events');
  await db.query('DELETE FROM usage_events');
  await db.query('DELETE FROM subscriptions');
});

test('Phase 5.2 - 1. Exact Invoice Arithmetic: total_cents equals base_fee + sum of line items', async () => {
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'arith-test-key-1')
    .send({
      input_tokens: 1000000,
      cached_tokens: 500000,
      output_tokens: 100000,
      reasoning_tokens: 50000,
    })
    .expect(200);

  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  const invoice = res.body.invoice;
  const baseFee = invoice.line_items[0].amount_cents;
  const inputFee = invoice.line_items[2].amount_cents;
  const cachedFee = invoice.line_items[3].amount_cents;
  const outputFee = invoice.line_items[4].amount_cents;
  const reasoningFee = invoice.line_items[5].amount_cents;

  const lineItemsSum = baseFee + inputFee + cachedFee + outputFee + reasoningFee;

  assert.strictEqual(invoice.subtotal_cents, lineItemsSum);
  assert.strictEqual(invoice.total_cents, lineItemsSum);
});

test('Phase 5.2 - 2. Zero-Usage Invoice: clean tenant has subtotal equal to plan base fee', async () => {
  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  const invoice = res.body.invoice;
  assert.strictEqual(invoice.subtotal_cents, 0); // Free plan base fee is 0
  assert.strictEqual(invoice.total_cents, 0);
  assert.strictEqual(invoice.line_items[1].quantity, 0); // API calls 0
  assert.strictEqual(invoice.line_items[2].quantity, 0); // Input tokens 0
});

test('Phase 5.2 - 3. Large Usage Quantities: handles large token volumes without arithmetic overflow or NaN', async () => {
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  // Generate 4,000,000 input tokens ($12.00 = 1200 cents, within Pro 5M quota)
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'large-qty-test-key-1')
    .send({
      input_tokens: 4000000,
      cached_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    })
    .expect(200);

  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  const invoice = res.body.invoice;
  assert.strictEqual(Number.isNaN(invoice.total_cents), false);
  assert.strictEqual(Number.isInteger(invoice.total_cents), true);
  assert.strictEqual(invoice.total_cents, 2900 + 1200); // 2900 (Pro base) + 1200 (4M input tokens)
});

test('Phase 5.2 - 4. Independent Token Categories: independently calculates input, cached, output, and reasoning line items', async () => {
  await request(app)
    .post('/api/v1/subscription/checkout')
    .send({ plan_name: 'Pro' })
    .expect(200);

  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'indep-cat-test-key-1')
    .send({
      input_tokens: 1000000,   // $3.00 = 300 cents
      cached_tokens: 1000000,  // $0.75 = 75 cents
      output_tokens: 100000,   // $1.50 = 150 cents
      reasoning_tokens: 100000,// $3.00 = 300 cents
    })
    .expect(200);

  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  const lineItems = res.body.invoice.line_items;
  assert.strictEqual(lineItems[2].amount_cents, 300); // Input
  assert.strictEqual(lineItems[3].amount_cents, 75);  // Cached
  assert.strictEqual(lineItems[4].amount_cents, 150); // Output
  assert.strictEqual(lineItems[5].amount_cents, 300); // Reasoning
});

test('Phase 5.2 - 5. API-Call Line Item: includes API call count in invoice statement', async () => {
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'api-call-item-key-1')
    .send({
      input_tokens: 100,
      cached_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    })
    .expect(200);

  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  const apiCallItem = res.body.invoice.line_items[1];
  assert.strictEqual(apiCallItem.description, 'API Call Requests');
  assert.strictEqual(apiCallItem.quantity, 1);
  assert.strictEqual(apiCallItem.amount_cents, 0);
});

test('Phase 5.2 - 6 & 7. Period Scoping: current invoice excludes previous-period usage events', async () => {
  const demoTenantRes = await db.query("SELECT id FROM tenants WHERE name = 'Demo Tenant' LIMIT 1");
  const tenantId = demoTenantRes.rows[0].id;

  // Insert historical usage event 60 days ago
  const pastDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, cost_cents, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, 'past-event-key-99', 'AI_TOKENS', 1, 1000000, 300, pastDate]
  );

  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  // Past event (60 days ago) must NOT be included in current monthly invoice
  const inputItem = res.body.invoice.line_items[2];
  assert.strictEqual(inputItem.quantity, 0);
  assert.strictEqual(res.body.invoice.total_cents, 0);
});

test('Phase 5.2 - 9. Idempotent Deduplication: duplicate POST /generate does not increase invoice total', async () => {
  const payload = {
    input_tokens: 50000,
    cached_tokens: 0,
    output_tokens: 10000,
    reasoning_tokens: 0,
  };

  // First request
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'idempotent-inv-dup-key-1')
    .send(payload)
    .expect(200);

  const res1 = await request(app).get('/api/v1/invoices/current').expect(200);
  const total1 = res1.body.invoice.total_cents;

  // Replay exact same request with same Idempotency-Key
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'idempotent-inv-dup-key-1')
    .send(payload)
    .expect(200);

  const res2 = await request(app).get('/api/v1/invoices/current').expect(200);
  const total2 = res2.body.invoice.total_cents;

  assert.strictEqual(total1, total2);
});

test('Phase 5.2 - 10. Failed Requests Safety: rejected request (400 Bad Request) creates no billable usage', async () => {
  const resBefore = await request(app).get('/api/v1/invoices/current').expect(200);

  // Send malformed payload (negative tokens -> 400 Bad Request)
  await request(app)
    .post('/api/v1/generate')
    .set('Idempotency-Key', 'rejected-req-key-1')
    .send({
      input_tokens: -500,
      cached_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    })
    .expect(400);

  const resAfter = await request(app).get('/api/v1/invoices/current').expect(200);
  assert.strictEqual(resBefore.body.invoice.total_cents, resAfter.body.invoice.total_cents);
});

test('Phase 5.2 - 11, 12 & 15. Multi-Tenant Isolation: Tenant A cannot access Tenant B invoice by ID or spoofing', async () => {
  // Create Tenant B
  const tenantBRes = await db.query(
    "INSERT INTO tenants (name) VALUES ('Tenant B') RETURNING id"
  );
  const tenantBId = tenantBRes.rows[0].id;

  // Query invoice for Tenant A (default Demo Tenant)
  const resA = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);
  const invoiceAId = resA.body.invoice.id;

  // Query invoice for Tenant B using x-tenant-id header
  const resB = await request(app)
    .get('/api/v1/invoices/current')
    .set('x-tenant-id', tenantBId)
    .expect(200);
  const invoiceBId = resB.body.invoice.id;

  assert.notStrictEqual(invoiceAId, invoiceBId);
  assert.strictEqual(resB.body.invoice.tenant_id, tenantBId);

  // Tenant B attempts to fetch Tenant A's invoice ID -> MUST return HTTP 404
  const spoofRes = await request(app)
    .get(`/api/v1/invoices/${invoiceAId}`)
    .set('x-tenant-id', tenantBId)
    .expect(404);

  assert.strictEqual(spoofRes.body.error, 'Not Found');
});

test('Phase 5.2 - 13. Side-Effect Free Read: repeated GET /invoices/current creates zero DB mutations', async () => {
  // Initialize tenant subscription first
  await request(app).get('/api/v1/invoices/current').expect(200);

  const eventsBefore = await db.query('SELECT COUNT(*)::integer FROM usage_events');
  const subsBefore = await db.query('SELECT COUNT(*)::integer FROM subscriptions');

  await request(app).get('/api/v1/invoices/current').expect(200);
  await request(app).get('/api/v1/invoices/current').expect(200);
  await request(app).get('/api/v1/invoices').expect(200);

  const eventsAfter = await db.query('SELECT COUNT(*)::integer FROM usage_events');
  const subsAfter = await db.query('SELECT COUNT(*)::integer FROM subscriptions');

  assert.strictEqual(eventsBefore.rows[0].count, eventsAfter.rows[0].count);
  assert.strictEqual(subsBefore.rows[0].count, subsAfter.rows[0].count);
});

test('Phase 5.2 - 14. Pricing Consistency: invoice line item calculations match pricingService exactly', async () => {
  const inputQty = 1234567;
  const cachedQty = 987654;
  const outputQty = 456789;
  const reasoningQty = 123456;

  const expectedInputCents = calculateTokenCost({ input_tokens: inputQty }).costCents;
  const expectedCachedCents = calculateTokenCost({ cached_tokens: cachedQty }).costCents;
  const expectedOutputCents = calculateTokenCost({ output_tokens: outputQty }).costCents;
  const expectedReasoningCents = calculateTokenCost({ reasoning_tokens: reasoningQty }).costCents;

  const demoTenantRes = await db.query("SELECT id FROM tenants WHERE name = 'Demo Tenant' LIMIT 1");
  const tenantId = demoTenantRes.rows[0].id;

  await db.query(
    `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, 'pricing-consistency-key-1', 'AI_TOKENS', 1, inputQty, cachedQty, outputQty, reasoningQty, 0]
  );

  const res = await request(app)
    .get('/api/v1/invoices/current')
    .expect(200);

  const lineItems = res.body.invoice.line_items;
  assert.strictEqual(lineItems[2].amount_cents, expectedInputCents);
  assert.strictEqual(lineItems[3].amount_cents, expectedCachedCents);
  assert.strictEqual(lineItems[4].amount_cents, expectedOutputCents);
  assert.strictEqual(lineItems[5].amount_cents, expectedReasoningCents);
});

test('Phase 5.2 - 17. Database Failure Error Propagation: DB errors propagate cleanly as sanitized HTTP 500', async () => {
  const originalQuery = db.query;
  db.query = async (text, params) => {
    if (text.includes('FROM usage_events')) {
      throw new Error('Database connection reset during invoice query.');
    }
    return originalQuery(text, params);
  };

  try {
    const res = await request(app)
      .get('/api/v1/invoices/current')
      .expect(500);

    assert.strictEqual(res.body.error, 'Internal Server Error');
    assert.strictEqual(res.body.message, 'An unexpected internal server error occurred.');
  } finally {
    db.query = originalQuery;
  }
});
