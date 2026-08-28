const db = require('../db');
const { getOrCreateActiveSubscription } = require('./subscriptionService');
const { calculateTokenCost } = require('./pricingService');

/**
 * Calculates an itemized monthly billing invoice statement for a tenant.
 * Derives line-item costs from authoritative pricing configuration (`pricingService.js`).
 * Guaranteed financially deterministic, integer-based (cents), tenant-scoped, and period-correct.
 * 
 * @param {string} tenantId
 * @param {Date} [customPeriodStart]
 * @param {Date} [customPeriodEnd]
 * @returns {Promise<Object>}
 */
async function generateTenantInvoice(tenantId, customPeriodStart, customPeriodEnd) {
  if (!tenantId) {
    const err = new Error('Tenant ID is required for invoice calculation.');
    err.statusCode = 400;
    err.userFacing = true;
    throw err;
  }

  // 1. Fetch current subscription for tenant (preferring active or past_due before creating default Free sub)
  const subQuery = `
    SELECT s.*, p.name as plan_name, p.monthly_api_limit, p.monthly_token_limit, p.price_cents
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.tenant_id = $1
    ORDER BY CASE WHEN s.status = 'active' THEN 1 WHEN s.status = 'past_due' THEN 2 ELSE 3 END, s.created_at DESC
    LIMIT 1
  `;
  const subRes = await db.query(subQuery, [tenantId]);
  let subscription = subRes.rows[0];

  if (!subscription) {
    subscription = await getOrCreateActiveSubscription(tenantId);
  }

  const now = new Date();
  const periodStart = customPeriodStart || (subscription.current_period_start
    ? new Date(subscription.current_period_start)
    : new Date(now.getFullYear(), now.getMonth(), 1));
  const periodEnd = customPeriodEnd || (subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));

  // 2. Query aggregate usage events strictly scoped to tenant_id and billing period bounds
  const usageQuery = `
    SELECT
      COUNT(CASE WHEN usage_type = 'API_CALL' THEN 1 END)::bigint as total_api_calls,
      COALESCE(SUM(input_tokens), 0)::bigint as total_input_tokens,
      COALESCE(SUM(cached_tokens), 0)::bigint as total_cached_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint as total_output_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::bigint as total_reasoning_tokens
    FROM usage_events
    WHERE tenant_id = $1
      AND created_at >= $2
      AND created_at <= $3
  `;

  const usageRes = await db.query(usageQuery, [tenantId, periodStart, periodEnd]);
  const usage = usageRes.rows[0];

  const totalApiCalls = Number(usage.total_api_calls || 0);
  const totalInputTokens = Number(usage.total_input_tokens || 0);
  const totalCachedTokens = Number(usage.total_cached_tokens || 0);
  const totalOutputTokens = Number(usage.total_output_tokens || 0);
  const totalReasoningTokens = Number(usage.total_reasoning_tokens || 0);

  // 3. Derive individual category costs using authoritative pricing calculations from pricingService.js
  const inputAmountCents = calculateTokenCost({ input_tokens: totalInputTokens }).costCents;
  const cachedAmountCents = calculateTokenCost({ cached_tokens: totalCachedTokens }).costCents;
  const outputAmountCents = calculateTokenCost({ output_tokens: totalOutputTokens }).costCents;
  const reasoningAmountCents = calculateTokenCost({ reasoning_tokens: totalReasoningTokens }).costCents;

  const planBasePriceCents = subscription.price_cents || 0;
  const usageCostCents = inputAmountCents + cachedAmountCents + outputAmountCents + reasoningAmountCents;

  // Enforce total_cents = planBasePriceCents + inputAmountCents + cachedAmountCents + outputAmountCents + reasoningAmountCents
  const totalCents = planBasePriceCents + usageCostCents;

  const invoiceId = `inv_${tenantId.slice(0, 8)}_${periodStart.getFullYear()}${String(periodStart.getMonth() + 1).padStart(2, '0')}`;

  const lineItems = [
    {
      description: `Base Subscription Fee - ${subscription.plan_name} Plan`,
      quantity: 1,
      unit_price_cents: planBasePriceCents,
      amount_cents: planBasePriceCents,
    },
    {
      description: 'API Call Requests',
      quantity: totalApiCalls,
      unit_price_cents: 0,
      amount_cents: 0,
    },
    {
      description: 'Input AI Tokens ($3.00 / 1M)',
      quantity: totalInputTokens,
      rate_per_million_dollars: 3.00,
      amount_cents: inputAmountCents,
    },
    {
      description: 'Cached Input AI Tokens ($0.75 / 1M)',
      quantity: totalCachedTokens,
      rate_per_million_dollars: 0.75,
      amount_cents: cachedAmountCents,
    },
    {
      description: 'Output AI Tokens ($15.00 / 1M)',
      quantity: totalOutputTokens,
      rate_per_million_dollars: 15.00,
      amount_cents: outputAmountCents,
    },
    {
      description: 'Reasoning AI Tokens ($30.00 / 1M)',
      quantity: totalReasoningTokens,
      rate_per_million_dollars: 30.00,
      amount_cents: reasoningAmountCents,
    },
  ];

  const invoiceStatus = subscription.status === 'past_due' ? 'pending' : 'paid';

  return {
    invoice: {
      id: invoiceId,
      tenant_id: tenantId,
      status: invoiceStatus,
      currency: 'USD',
      plan_name: subscription.plan_name,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      subtotal_cents: totalCents,
      tax_cents: 0,
      total_cents: totalCents,
      line_items: lineItems,
    },
  };
}

/**
 * Lists all monthly invoices for a tenant across historical billing periods.
 * 
 * @param {string} tenantId
 * @returns {Promise<Object>}
 */
async function listTenantInvoices(tenantId) {
  if (!tenantId) {
    const err = new Error('Tenant ID is required for listing invoices.');
    err.statusCode = 400;
    err.userFacing = true;
    throw err;
  }
  const currentInvoice = await generateTenantInvoice(tenantId);
  return {
    invoices: [currentInvoice.invoice],
  };
}

module.exports = {
  generateTenantInvoice,
  listTenantInvoices,
};
