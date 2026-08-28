const crypto = require('crypto');
const db = require('../db');

/**
 * Find an existing usage event by tenant ID and idempotency key.
 * 
 * @param {string} tenantId
 * @param {string} idempotencyKey
 * @returns {Promise<Object|null>}
 */
async function findUsageEvent(tenantId, idempotencyKey) {
  const queryText = `
    SELECT * FROM usage_events 
    WHERE tenant_id = $1 AND idempotency_key = $2 
    LIMIT 1
  `;
  const result = await db.query(queryText, [tenantId, idempotencyKey]);
  return result.rows[0] || null;
}

/**
 * Record a usage event in the database.
 * If a unique constraint conflict (code 23505) occurs for (tenant_id, idempotency_key),
 * it returns the existing record safely.
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

  try {
    const result = await db.query(queryText, values);
    return result.rows[0];
  } catch (error) {
    // 23505 is PostgreSQL error code for unique_violation
    if (error.code === '23505') {
      const existingRecord = await findUsageEvent(tenantId, idempotencyKey);
      if (existingRecord) {
        return existingRecord;
      }
    }
    throw error;
  }
}

module.exports = {
  findUsageEvent,
  recordUsageEvent,
};
