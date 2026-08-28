const db = require('../db');
const { getPaymentProvider } = require('./paymentProvider');

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

/**
 * Retrieves the current subscription details for a tenant.
 * Throws 404 if no subscription exists for the tenant.
 * 
 * @param {string} tenantId
 * @returns {Promise<Object>}
 */
async function getTenantSubscriptionDetails(tenantId) {
  const query = `
    SELECT s.*, p.name as plan_name, p.monthly_api_limit, p.monthly_token_limit, p.price_cents, t.name as tenant_name
    FROM subscriptions s
    JOIN plans p ON s.plan_id = p.id
    JOIN tenants t ON s.tenant_id = t.id
    WHERE s.tenant_id = $1
    ORDER BY CASE WHEN s.status = 'active' THEN 1 ELSE 2 END, s.created_at DESC
    LIMIT 1
  `;

  const result = await db.query(query, [tenantId]);
  if (result.rows.length === 0) {
    const error = new Error('No active subscription found for tenant.');
    error.statusCode = 404;
    throw error;
  }

  const sub = result.rows[0];
  const provider = getPaymentProvider();

  return {
    tenant: {
      id: sub.tenant_id,
      name: sub.tenant_name,
    },
    subscription: {
      id: sub.id,
      provider: provider.name,
      customer_id: sub.stripe_customer_id,
      subscription_id: sub.stripe_subscription_id,
      plan: {
        name: sub.plan_name,
        price_cents: sub.price_cents,
        monthly_api_limit: sub.monthly_api_limit,
        monthly_token_limit: sub.monthly_token_limit,
      },
      status: sub.status,
      current_period_start: sub.current_period_start ? new Date(sub.current_period_start).toISOString() : null,
      current_period_end: sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null,
    },
  };
}

/**
 * Transactionally cancels the active subscription for a tenant.
 * Calls payment provider cancellation abstraction and updates PostgreSQL status to 'canceled'.
 * 
 * @param {string} tenantId
 * @returns {Promise<Object>}
 */
async function cancelTenantActiveSubscription(tenantId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock active subscription row for tenant
    const subRes = await client.query(
      `SELECT s.*, p.name as plan_name 
       FROM subscriptions s 
       JOIN plans p ON s.plan_id = p.id 
       WHERE s.tenant_id = $1 AND s.status = 'active' 
       FOR UPDATE`,
      [tenantId]
    );

    if (subRes.rows.length === 0) {
      const error = new Error('No active subscription found to cancel.');
      error.statusCode = 404;
      throw error;
    }

    const sub = subRes.rows[0];
    const provider = getPaymentProvider();

    // 2. Call payment provider cancellation if subscription_id exists
    if (sub.stripe_subscription_id) {
      try {
        await provider.cancelSubscription(sub.stripe_subscription_id);
      } catch (providerError) {
        console.warn(`Payment provider cancelSubscription warning: ${providerError.message}`);
      }
    }

    // 3. Update PostgreSQL subscription status to 'canceled'
    const updateRes = await client.query(
      "UPDATE subscriptions SET status = 'canceled' WHERE id = $1 RETURNING *",
      [sub.id]
    );
    const updatedSub = updateRes.rows[0];

    await client.query('COMMIT');

    return {
      success: true,
      message: 'Subscription cancelled successfully.',
      subscription: {
        id: updatedSub.id,
        provider: provider.name,
        plan: sub.plan_name,
        status: updatedSub.status,
        customer_id: updatedSub.stripe_customer_id,
        subscription_id: updatedSub.stripe_subscription_id,
        current_period_start: updatedSub.current_period_start ? new Date(updatedSub.current_period_start).toISOString() : null,
        current_period_end: updatedSub.current_period_end ? new Date(updatedSub.current_period_end).toISOString() : null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getOrCreateActiveSubscription,
  getTenantSubscriptionDetails,
  cancelTenantActiveSubscription,
};
