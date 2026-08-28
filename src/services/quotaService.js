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
 * Validates monthly quotas and atomically records both API_CALL and AI_TOKENS usage events
 * in a single PostgreSQL transaction with FOR UPDATE row-level locking.
 * Safe against concurrent duplicate requests.
 */
async function checkAndRecordUsageTransaction({
  tenantId,
  idempotencyKey,
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

    // 2. Query total API calls used (usage_type = 'API_CALL')
    const apiCallsQuery = `
      SELECT COUNT(*)::integer as api_calls_used
      FROM usage_events
      WHERE tenant_id = $1
        AND usage_type = 'API_CALL'
        AND created_at >= $2
        AND created_at <= $3
    `;
    const apiCallsResult = await client.query(apiCallsQuery, [tenantId, periodStart, periodEnd]);
    const currentApiCalls = apiCallsResult.rows[0].api_calls_used;

    // 3. Query total AI tokens used (usage_type = 'AI_TOKENS')
    const aiTokensQuery = `
      SELECT COALESCE(SUM(quantity), 0)::integer as ai_tokens_used
      FROM usage_events
      WHERE tenant_id = $1
        AND usage_type = 'AI_TOKENS'
        AND created_at >= $2
        AND created_at <= $3
    `;
    const aiTokensResult = await client.query(aiTokensQuery, [tenantId, periodStart, periodEnd]);
    const currentTokens = aiTokensResult.rows[0].ai_tokens_used;

    // 4. Enforce API Call Quota (COUNT(API_CALL))
    if (currentApiCalls + 1 > subscription.monthly_api_limit) {
      throw new QuotaExceededError('API_CALLS', subscription.monthly_api_limit, currentApiCalls, 1);
    }

    // 5. Enforce Token Quota (SUM(AI_TOKENS.quantity))
    if (currentTokens + quantity > subscription.monthly_token_limit) {
      throw new QuotaExceededError('AI_TOKENS', subscription.monthly_token_limit, currentTokens, quantity);
    }

    // 6. Calculate AI Token Cost using integer monetary arithmetic
    const finalCostCents = typeof costCents === 'number'
      ? costCents
      : calculateTokenCost({
          input_tokens: inputTokens,
          cached_tokens: cachedTokens,
          output_tokens: outputTokens,
          reasoning_tokens: reasoningTokens,
        }).costCents;

    // Derive deterministic, unique idempotency keys for both events
    const apiEventKey = `${idempotencyKey}:api`;
    const tokensEventKey = `${idempotencyKey}:tokens`;

    // 7. Insert API_CALL usage event (quantity = 1, token fields = 0, cost_cents = 0)
    const insertApiQuery = `
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
      ) VALUES ($1, $2, 'API_CALL', 1, 0, 0, 0, 0, 0)
    `;
    await client.query(insertApiQuery, [tenantId, apiEventKey]);

    // 8. Insert AI_TOKENS usage event (quantity = total_tokens, stored token categories, cost_cents)
    const insertTokensQuery = `
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
      ) VALUES ($1, $2, 'AI_TOKENS', $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const tokensResult = await client.query(insertTokensQuery, [
      tenantId,
      tokensEventKey,
      quantity,
      inputTokens,
      cachedTokens,
      outputTokens,
      reasoningTokens,
      finalCostCents,
    ]);

    await client.query('COMMIT');
    return tokensResult.rows[0];
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
