const db = require('../db');
const { getPaymentProvider } = require('./paymentProvider');

/**
 * Creates a subscription checkout session using the payment provider abstraction
 * and updates/creates the active subscription record in PostgreSQL.
 * 
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.planName
 * @returns {Promise<Object>}
 */
async function createSubscriptionCheckout({ tenantId, planName }) {
  // 1. Fetch target plan from database
  const planResult = await db.query('SELECT * FROM plans WHERE name = $1 LIMIT 1', [planName]);
  if (planResult.rows.length === 0) {
    const error = new Error(`Plan '${planName}' not found.`);
    error.statusCode = 404;
    throw error;
  }
  const targetPlan = planResult.rows[0];

  // 2. Obtain payment provider instance via abstraction
  const provider = getPaymentProvider();

  // 3. Create checkout session using payment provider interface
  const session = await provider.createCheckoutSession({
    tenantId,
    planId: targetPlan.id,
    customerEmail: 'demo@flyrank.com',
  });

  // 4. Calculate billing period (current calendar month)
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 5. Lock tenant row to serialize concurrent subscription updates
    await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);

    // 6. Check if tenant already has an active subscription
    const existingSubRes = await client.query(
      "SELECT id FROM subscriptions WHERE tenant_id = $1 AND status = 'active' LIMIT 1 FOR UPDATE",
      [tenantId]
    );

    let subscriptionRow;
    if (existingSubRes.rows.length > 0) {
      // Update existing subscription to switch plan and populate provider IDs
      const updateQuery = `
        UPDATE subscriptions
        SET plan_id = $1,
            stripe_customer_id = $2,
            stripe_subscription_id = $3,
            current_period_start = $4,
            current_period_end = $5,
            status = 'active'
        WHERE id = $6
        RETURNING *
      `;
      const updateRes = await client.query(updateQuery, [
        targetPlan.id,
        session.customerId,
        session.subscriptionId,
        periodStart,
        periodEnd,
        existingSubRes.rows[0].id,
      ]);
      subscriptionRow = updateRes.rows[0];
    } else {
      // Create new active subscription
      const insertQuery = `
        INSERT INTO subscriptions (
          tenant_id,
          plan_id,
          status,
          stripe_customer_id,
          stripe_subscription_id,
          current_period_start,
          current_period_end
        ) VALUES ($1, $2, 'active', $3, $4, $5, $6)
        RETURNING *
      `;
      const insertRes = await client.query(insertQuery, [
        tenantId,
        targetPlan.id,
        session.customerId,
        session.subscriptionId,
        periodStart,
        periodEnd,
      ]);
      subscriptionRow = insertRes.rows[0];
    }

    await client.query('COMMIT');

    return {
      success: true,
      checkout: {
        provider: provider.name,
        session_id: session.id,
        subscription_id: session.subscriptionId,
        plan: targetPlan.name,
        status: subscriptionRow.status,
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
  createSubscriptionCheckout,
};
