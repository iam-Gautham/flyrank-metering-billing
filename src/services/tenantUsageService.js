const db = require('../db');
const { getOrCreateActiveSubscription } = require('./subscriptionService');

/**
 * Calculates current billing period usage, limits, and remaining quotas for a tenant.
 * Does not mutate database records.
 * 
 * @param {string} tenantId
 * @returns {Promise<Object>}
 */
async function getTenantUsage(tenantId) {
  // 1. Fetch tenant record
  const tenantRes = await db.query('SELECT id, name FROM tenants WHERE id = $1 LIMIT 1', [tenantId]);
  if (tenantRes.rows.length === 0) {
    throw new Error(`Tenant with ID ${tenantId} not found.`);
  }
  const tenant = tenantRes.rows[0];

  // 2. Fetch active subscription & plan limits
  const subscription = await getOrCreateActiveSubscription(tenantId);

  const now = new Date();
  const periodStart = subscription.current_period_start
    ? new Date(subscription.current_period_start)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end)
    : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // 3. Query API calls count within billing period (usage_type = 'API_CALL')
  const apiCallsQuery = `
    SELECT COUNT(*)::integer as api_calls_used
    FROM usage_events
    WHERE tenant_id = $1
      AND usage_type = 'API_CALL'
      AND created_at >= $2
      AND created_at <= $3
  `;
  const apiCallsRes = await db.query(apiCallsQuery, [tenantId, periodStart, periodEnd]);
  const apiCallsUsed = apiCallsRes.rows[0].api_calls_used;

  // 4. Query AI tokens count within billing period (usage_type = 'AI_TOKENS')
  const aiTokensQuery = `
    SELECT COALESCE(SUM(quantity), 0)::integer as ai_tokens_used
    FROM usage_events
    WHERE tenant_id = $1
      AND usage_type = 'AI_TOKENS'
      AND created_at >= $2
      AND created_at <= $3
  `;
  const aiTokensRes = await db.query(aiTokensQuery, [tenantId, periodStart, periodEnd]);
  const aiTokensUsed = aiTokensRes.rows[0].ai_tokens_used;

  // 5. Calculate remaining quotas
  const apiLimit = subscription.monthly_api_limit;
  const tokenLimit = subscription.monthly_token_limit;

  const remainingApiCalls = Math.max(0, apiLimit - apiCallsUsed);
  const remainingAiTokens = Math.max(0, tokenLimit - aiTokensUsed);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
    },
    plan: {
      name: subscription.plan_name,
    },
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
    usage: {
      api_calls: {
        used: apiCallsUsed,
        limit: apiLimit,
        remaining: remainingApiCalls,
      },
      ai_tokens: {
        used: aiTokensUsed,
        limit: tokenLimit,
        remaining: remainingAiTokens,
      },
    },
  };
}

module.exports = {
  getTenantUsage,
};
