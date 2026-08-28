const db = require('../db');
const { getOrCreateActiveSubscription } = require('./subscriptionService');
const { findUsageEvent } = require('./usageService');
const { calculateTokenCost } = require('./pricingService');

class QuotaExceededError extends Error {
  constructor(quotaType, limit, currentUsage, requestedAmount) {
    const quotaLabel = quotaType === 'API_CALLS' ? 'API call' : 'AI token';
    super(`Monthly ${quotaLabel} limit exceeded. Limit: ${limit}, Current: ${currentUsage}, Requested: ${requestedAmount}.`);
    this.name = 'QuotaExceededError';
    this.quotaType = quotaType; // 'API_CALLS' or 'AI_TOKENS'
    this.limit = limit;
    this.currentUsage = currentUsage;
    this.requestedAmount = requestedAmount;
  }
}

/**
 * Validates monthly quotas and records usage in a single transaction with FOR UPDATE row-level locking.
 * Safe against concurrent duplicate requests.
 */
async function checkAndRecordUsageTransaction({
  tenantId,
  idempotencyKey,
  usageType = 'AI_TOKENS',
  quantity,
  inputTokens = 0,
  cachedTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  costCents,
}) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock subscription row and get active plan limits
    const subscription = await getOrCreateActiveSubscription(tenantId, client, true);

    const now = new Date();
    const periodStart = subscription.current_period_start
      ? new Date(subscription.current_period_start)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // 2. Query total usage in current billing period
    const usageQuery = `
      SELECT 
        COUNT(*)::integer as total_api_calls,
        COALESCE(SUM(quantity), 0)::integer as total_tokens
      FROM usage_events
      WHERE tenant_id = $1
        AND created_at >= $2
        AND created_at <= $3
    `;
    const usageResult = await client.query(usageQuery, [tenantId, periodStart, periodEnd]);
    const currentApiCalls = usageResult.rows[0].total_api_calls;
    const currentTokens = usageResult.rows[0].total_tokens;

    // 3. Enforce API Call Quota
    if (currentApiCalls + 1 > subscription.monthly_api_limit) {
      throw new QuotaExceededError('API_CALLS', subscription.monthly_api_limit, currentApiCalls, 1);
    }

    // 4. Enforce Token Quota
    if (currentTokens + quantity > subscription.monthly_token_limit) {
      throw new QuotaExceededError('AI_TOKENS', subscription.monthly_token_limit, currentTokens, quantity);
    }

    // 5. Calculate AI Token Cost using integer monetary arithmetic if costCents not explicitly supplied
    const finalCostCents = typeof costCents === 'number'
      ? costCents
      : calculateTokenCost({
          input_tokens: inputTokens,
          cached_tokens: cachedTokens,
          output_tokens: outputTokens,
          reasoning_tokens: reasoningTokens,
        }).costCents;

    // 6. Insert Usage Event
    const insertQuery = `
      INSERT INTO usage_events (
        tenant_id,
        idempotency_key,
        usage_type,
        quantity,
        input_tokens,
        cached_tokens,
        output_tokens,
        reasoning_tokens,
        cost_cents
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    const insertValues = [
      tenantId,
      idempotencyKey,
      usageType,
      quantity,
      inputTokens,
      cachedTokens,
      outputTokens,
      reasoningTokens,
      finalCostCents,
    ];

    const insertResult = await client.query(insertQuery, insertValues);

    await client.query('COMMIT');
    return insertResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    // Handle unique_violation (code 23505) gracefully if concurrent insert happened
    if (error.code === '23505') {
      const existing = await findUsageEvent(tenantId, idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  QuotaExceededError,
  checkAndRecordUsageTransaction,
};
