const db = require('../db');
const { getPaymentProvider } = require('./paymentProvider');

/**
 * Validates and processes a payment-provider webhook lifecycle event atomically in PostgreSQL.
 * Uses the existing usage_events table for 100% database-enforced, transaction-safe idempotency.
 * 
 * @param {Object} event - The webhook event payload
 * @returns {Promise<Object>}
 */
async function processWebhookEvent(event) {
  // 1. Validate payload structure
  if (!event || typeof event !== 'object') {
    const err = new Error('Invalid webhook payload.');
    err.statusCode = 400;
    throw err;
  }

  const { id, type, data } = event;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    const err = new Error('Webhook payload must include a valid id.');
    err.statusCode = 400;
    throw err;
  }

  if (!type || typeof type !== 'string') {
    const err = new Error('Webhook payload must include a valid type.');
    err.statusCode = 400;
    throw err;
  }

  const supportedTypes = ['subscription.created', 'subscription.updated', 'subscription.cancelled', 'subscription.canceled'];
  if (!supportedTypes.includes(type)) {
    const err = new Error(`Unsupported event type: ${type}`);
    err.statusCode = 400;
    throw err;
  }

  if (!data || typeof data !== 'object') {
    const err = new Error('Webhook payload must include a data object.');
    err.statusCode = 400;
    throw err;
  }

  const { subscription_id, status, plan_name } = data;
  if (!subscription_id || typeof subscription_id !== 'string' || subscription_id.trim() === '') {
    const err = new Error('Webhook data must include subscription_id.');
    err.statusCode = 400;
    throw err;
  }

  // 2. Invoke provider abstraction processEvent (simulated verification / processing)
  const provider = getPaymentProvider();
  await provider.processEvent(event);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 3. Locate and lock subscription row in PostgreSQL
    const subRes = await client.query(
      `SELECT s.*, p.name as plan_name 
       FROM subscriptions s 
       JOIN plans p ON s.plan_id = p.id 
       WHERE s.stripe_subscription_id = $1 OR s.id::text = $1 
       FOR UPDATE`,
      [subscription_id]
    );

    if (subRes.rows.length === 0) {
      const err = new Error(`Subscription '${subscription_id}' not found.`);
      err.statusCode = 404;
      throw err;
    }

    const sub = subRes.rows[0];
    const tenantId = sub.tenant_id;

    // 4. Idempotency Check: search for marker event in usage_events
    const idempotencyMarkerKey = `webhook:${id}`;
    const markerRes = await client.query(
      'SELECT id FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
      [tenantId, idempotencyMarkerKey]
    );

    if (markerRes.rows.length > 0) {
      await client.query('COMMIT');
      return {
        success: true,
        message: 'Event already processed.',
        idempotent: true,
        event_id: id,
        subscription_id,
        status: sub.status,
      };
    }

    // 5. Resolve plan if plan_name is specified in event
    let targetPlanId = sub.plan_id;
    if (plan_name) {
      const planRes = await client.query('SELECT id FROM plans WHERE name = $1 LIMIT 1', [plan_name]);
      if (planRes.rows.length === 0) {
        const err = new Error(`Plan '${plan_name}' not found.`);
        err.statusCode = 400;
        throw err;
      }
      targetPlanId = planRes.rows[0].id;
    }

    // 6. Calculate new subscription status based on lifecycle event type
    let newStatus = sub.status;
    if (type === 'subscription.created') {
      newStatus = status || 'active';
    } else if (type === 'subscription.updated') {
      newStatus = status || sub.status;
    } else if (type === 'subscription.cancelled' || type === 'subscription.canceled') {
      newStatus = 'canceled';
    }

    // 7. Update PostgreSQL Subscription record
    const updateSubQuery = `
      UPDATE subscriptions
      SET status = $1,
          plan_id = $2
      WHERE id = $3
      RETURNING *
    `;
    const updatedSubRes = await client.query(updateSubQuery, [newStatus, targetPlanId, sub.id]);
    const finalSub = updatedSubRes.rows[0];

    // 8. Insert Idempotency Marker into usage_events
    const insertMarkerQuery = `
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
      ) VALUES ($1, $2, 'WEBHOOK_EVENT', 0, 0, 0, 0, 0, 0)
    `;
    await client.query(insertMarkerQuery, [tenantId, idempotencyMarkerKey]);

    await client.query('COMMIT');

    return {
      success: true,
      message: `Successfully processed event '${type}'.`,
      event_id: id,
      subscription_id,
      status: finalSub.status,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  processWebhookEvent,
};
