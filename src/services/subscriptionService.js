const db = require('../db');

/**
 * Gets or creates an active subscription for the given tenant.
 * Accepts a custom database query function or client for transaction compatibility.
 * 
 * @param {string} tenantId
 * @param {Object} [dbClient] - Optional pg pool client or db module
 * @param {boolean} [forUpdate=false] - Whether to acquire a FOR UPDATE lock
 */
async function getOrCreateActiveSubscription(tenantId, dbClient = db, forUpdate = false) {
  const lockClause = forUpdate ? 'FOR UPDATE' : '';
  
  // 1. Query active subscription joined with plan limits
  const selectQuery = `
    SELECT s.*, p.name as plan_name, p.monthly_api_limit, p.monthly_token_limit, p.price_cents
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.tenant_id = $1 AND s.status = 'active'
    LIMIT 1
    ${lockClause}
  `;

  const subResult = await dbClient.query(selectQuery, [tenantId]);
  if (subResult.rows.length > 0) {
    return subResult.rows[0];
  }

  // If locking is requested, lock the tenant row to serialize concurrent default subscription creation
  if (forUpdate) {
    await dbClient.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    // Re-check if another concurrent transaction inserted the subscription while waiting
    const recheckResult = await dbClient.query(selectQuery, [tenantId]);
    if (recheckResult.rows.length > 0) {
      return recheckResult.rows[0];
    }
  }

  // 2. If no active subscription exists, fetch the Free plan
  const planResult = await dbClient.query("SELECT * FROM plans WHERE name = 'Free' LIMIT 1");
  if (planResult.rows.length === 0) {
    throw new Error("Free plan not found in database. Please run db:seed.");
  }
  const freePlan = planResult.rows[0];

  // 3. Create default active subscription for current billing period (current calendar month)
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const insertQuery = `
    INSERT INTO subscriptions (
      tenant_id,
      plan_id,
      status,
      current_period_start,
      current_period_end
    ) VALUES ($1, $2, 'active', $3, $4)
    RETURNING *
  `;

  const insertResult = await dbClient.query(insertQuery, [
    tenantId,
    freePlan.id,
    periodStart,
    periodEnd,
  ]);

  const newSub = insertResult.rows[0];
  return {
    ...newSub,
    plan_name: freePlan.name,
    monthly_api_limit: freePlan.monthly_api_limit,
    monthly_token_limit: freePlan.monthly_token_limit,
    price_cents: freePlan.price_cents,
  };
}

module.exports = {
  getOrCreateActiveSubscription,
};
