const crypto = require('crypto');
const db = require('../db');

/**
 * Record a usage event in the database.
 * 
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} [params.idempotencyKey]
 * @param {string} [params.usageType='AI_TOKENS']
 * @param {number} params.quantity
 * @param {number} params.inputTokens
 * @param {number} params.cachedTokens
 * @param {number} params.outputTokens
 * @param {number} params.reasoningTokens
 * @param {number} [params.costCents=0]
 */
async function recordUsageEvent({
  tenantId,
  idempotencyKey = crypto.randomUUID(),
  usageType = 'AI_TOKENS',
  quantity,
  inputTokens = 0,
  cachedTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  costCents = 0,
}) {
  const queryText = `
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

  const values = [
    tenantId,
    idempotencyKey,
    usageType,
    quantity,
    inputTokens,
    cachedTokens,
    outputTokens,
    reasoningTokens,
    costCents,
  ];

  const result = await db.query(queryText, values);
  return result.rows[0];
}

module.exports = {
  recordUsageEvent,
};
