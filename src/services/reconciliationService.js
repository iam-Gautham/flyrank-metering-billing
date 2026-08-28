const db = require('../db');
const { getPaymentProvider } = require('./paymentProvider');
const logger = require('../utils/logger');

/**
 * Reconciles local PostgreSQL subscription state for a tenant with the payment provider state.
 * Guaranteed deterministic, idempotent, safe to rerun, and bounded.
 * 
 * @param {string} tenantId
 * @returns {Promise<Object>}
 */
async function reconcileTenantSubscription(tenantId) {
  if (!tenantId) {
    const err = new Error('Tenant ID is required for subscription reconciliation.');
    err.statusCode = 400;
    throw err;
  }

  // 1. Fetch current subscription from PostgreSQL
  const subRes = await db.query(
    `SELECT s.*, p.name as plan_name
     FROM subscriptions s
     JOIN plans p ON s.plan_id = p.id
     WHERE s.tenant_id = $1
     ORDER BY CASE WHEN s.status = 'active' THEN 1 WHEN s.status = 'past_due' THEN 2 ELSE 3 END, s.created_at DESC
     LIMIT 1`,
    [tenantId]
  );

  if (subRes.rows.length === 0) {
    return {
      status: 'consistent',
      tenant_id: tenantId,
      message: 'No subscription row found for tenant.',
      updated: false,
    };
  }

  const sub = subRes.rows[0];

  // If subscription has no provider subscription ID, it is local default Free sub
  if (!sub.stripe_subscription_id) {
    return {
      status: 'consistent',
      tenant_id: tenantId,
      current_status: sub.status,
      plan_name: sub.plan_name,
      updated: false,
    };
  }

  const provider = getPaymentProvider();

  // 2. Fetch authoritative state from payment provider
  let providerSub;
  try {
    providerSub = await provider.getSubscription(sub.stripe_subscription_id);
  } catch (providerError) {
    logger.warn('reconciliationService', `Provider subscription look-up failed for '${sub.stripe_subscription_id}': ${providerError.message}`);
    return {
      status: 'inconsistency_detected',
      tenant_id: tenantId,
      current_status: sub.status,
      provider_subscription_id: sub.stripe_subscription_id,
      reason: `Payment provider error: ${providerError.message}`,
      action_required: 'manual_audit',
      updated: false,
    };
  }

  if (!providerSub) {
    logger.warn('reconciliationService', `Subscription '${sub.stripe_subscription_id}' not found in payment provider.`);
    return {
      status: 'inconsistency_detected',
      tenant_id: tenantId,
      current_status: sub.status,
      provider_subscription_id: sub.stripe_subscription_id,
      reason: 'Subscription not found in payment provider gateway.',
      action_required: 'manual_audit',
      updated: false,
    };
  }

  // 3. Compare local status with payment provider status
  if (sub.status === providerSub.status) {
    return {
      status: 'consistent',
      tenant_id: tenantId,
      current_status: sub.status,
      plan_name: sub.plan_name,
      updated: false,
    };
  }

  // 4. Safely update PostgreSQL subscription state if status differs
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const updateRes = await client.query(
      `UPDATE subscriptions SET status = $1 WHERE id = $2 RETURNING *`,
      [providerSub.status, sub.id]
    );
    await client.query('COMMIT');

    logger.info('reconciliationService', `Reconciled subscription status for tenant '${tenantId}': ${sub.status} -> ${providerSub.status}`);

    return {
      status: 'reconciled',
      tenant_id: tenantId,
      previous_status: sub.status,
      new_status: updateRes.rows[0].status,
      updated: true,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('reconciliationService', `Failed to persist reconciled subscription state for tenant '${tenantId}': ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  reconcileTenantSubscription,
};
