const db = require('../db');
const { getPaymentProvider } = require('./paymentProvider');

/**
 * Creates a subscription checkout session using the payment provider abstraction
 * and updates/creates the active subscription record in PostgreSQL.
 * Supports Idempotency-Key header processing and guarantees single active subscription invariant.
 * 
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.planName
 * @param {string} [params.idempotencyKey]
 * @returns {Promise<Object>}
 */
async function createSubscriptionCheckout({ tenantId, planName, idempotencyKey }) {
  // 1. Fetch target plan from database
  const planResult = await db.query('SELECT * FROM plans WHERE name = $1 LIMIT 1', [planName]);
  if (planResult.rows.length === 0) {
    const error = new Error(`Plan '${planName}' not found.`);
    error.statusCode = 404;
    throw error;
  }
  const targetPlan = planResult.rows[0];
  const provider = getPaymentProvider();

  const formattedKey = idempotencyKey ? `checkout:${idempotencyKey}` : null;

  // 2. Pre-check idempotency key if provided
  if (formattedKey) {
    const existingMarker = await db.query(
      'SELECT id FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
      [tenantId, formattedKey]
    );

    if (existingMarker.rows.length > 0) {
      const activeSubRes = await db.query(
        `SELECT s.*, p.name as plan_name
         FROM subscriptions s
         JOIN plans p ON s.plan_id = p.id
         WHERE s.tenant_id = $1 AND s.status = 'active' LIMIT 1`,
        [tenantId]
      );
      const sub = activeSubRes.rows[0];
      return {
        success: true,
        checkout: {
          provider: provider.name,
          session_id: `fake_checkout_${idempotencyKey.slice(0, 16)}`,
          subscription_id: sub ? sub.stripe_subscription_id : 'fake_sub_cached',
          plan: sub ? sub.plan_name : targetPlan.name,
          status: sub ? sub.status : 'active',
        },
        idempotent: true,
      };
    }
  }

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

    // 5. Check idempotency marker under transaction lock if key provided
    if (formattedKey) {
      const txMarker = await client.query(
        'SELECT id FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1 FOR UPDATE',
        [tenantId, formattedKey]
      );
      if (txMarker.rows.length > 0) {
        await client.query('COMMIT');
        const activeSubRes = await db.query(
          `SELECT s.*, p.name as plan_name
           FROM subscriptions s
           JOIN plans p ON s.plan_id = p.id
           WHERE s.tenant_id = $1 AND s.status = 'active' LIMIT 1`,
          [tenantId]
        );
        const sub = activeSubRes.rows[0];
        return {
          success: true,
          checkout: {
            provider: provider.name,
            session_id: `fake_checkout_${idempotencyKey.slice(0, 16)}`,
            subscription_id: sub ? sub.stripe_subscription_id : session.subscriptionId,
            plan: sub ? sub.plan_name : targetPlan.name,
            status: sub ? sub.status : 'active',
          },
          idempotent: true,
        };
      }
    }

    // 6. Lock tenant row to serialize concurrent subscription updates
    await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);

    // 7. Check if tenant already has an active subscription
    const existingSubRes = await client.query(
      "SELECT id FROM subscriptions WHERE tenant_id = $1 AND status = 'active' LIMIT 1 FOR UPDATE",
      [tenantId]
    );

    let subscriptionRow;
    if (existingSubRes.rows.length > 0) {
      // Update existing active subscription to switch plan and populate provider IDs
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

    // Deactivate any other active subscription rows to enforce single active subscription invariant
    await client.query(
      "UPDATE subscriptions SET status = 'canceled' WHERE tenant_id = $1 AND id != $2 AND status = 'active'",
      [tenantId, subscriptionRow.id]
    );

    // 8. Record idempotency marker if key was provided
    if (formattedKey) {
      await client.query(
        `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_cents)
         VALUES ($1, $2, 'CHECKOUT_EVENT', 0, 0, 0, 0, 0, 0)`,
        [tenantId, formattedKey]
      );
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
    // Handle unique constraint 23505 on formattedKey for concurrent duplicate checkout requests
    if (error.code === '23505' && formattedKey) {
      const activeSubRes = await db.query(
        `SELECT s.*, p.name as plan_name
         FROM subscriptions s
         JOIN plans p ON s.plan_id = p.id
         WHERE s.tenant_id = $1 AND s.status = 'active' LIMIT 1`,
        [tenantId]
      );
      const sub = activeSubRes.rows[0];
      return {
        success: true,
        checkout: {
          provider: provider.name,
          session_id: `fake_checkout_${idempotencyKey.slice(0, 16)}`,
          subscription_id: sub ? sub.stripe_subscription_id : session.subscriptionId,
          plan: sub ? sub.plan_name : targetPlan.name,
          status: sub ? sub.status : 'active',
        },
        idempotent: true,
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createSubscriptionCheckout,
};
