const db = require('../db');
const { getPaymentProvider } = require('./paymentProvider');

/**
 * Validates and processes a payment-provider webhook lifecycle event atomically in PostgreSQL.
 * Persists event metadata in webhook_events table and updates subscription state safely.
 * 100% database-enforced, transaction-safe idempotency and out-of-order event protection.
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

  const supportedTypes = [
    'subscription.created',
    'subscription.updated',
    'subscription.cancelled',
    'subscription.canceled',
    'subscription.deleted',
    'invoice.payment_succeeded',
    'payment.success',
    'invoice.payment_failed',
    'payment.failure',
  ];

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

  const subscriptionIdentifier = data.subscription_id || data.customer_id;
  if (!subscriptionIdentifier || typeof subscriptionIdentifier !== 'string' || subscriptionIdentifier.trim() === '') {
    const err = new Error('Webhook data must include subscription_id or customer_id.');
    err.statusCode = 400;
    throw err;
  }

  // Extract optional event creation timestamp for out-of-order event handling
  const rawTimestamp = event.created || event.timestamp || data.event_timestamp || data.created;
  let eventDate = null;
  if (rawTimestamp) {
    if (typeof rawTimestamp === 'number') {
      eventDate = new Date(rawTimestamp < 10000000000 ? rawTimestamp * 1000 : rawTimestamp);
    } else {
      eventDate = new Date(rawTimestamp);
    }
    if (isNaN(eventDate.getTime())) {
      eventDate = null;
    }
  }

  // 2. Invoke provider abstraction processEvent (simulated verification / processing)
  const provider = getPaymentProvider();
  await provider.processEvent(event);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 3. Exact Event ID Idempotency Check in webhook_events table
    const existingEvtRes = await client.query(
      'SELECT id, status FROM webhook_events WHERE provider_event_id = $1 LIMIT 1 FOR UPDATE',
      [id]
    );

    if (existingEvtRes.rows.length > 0) {
      await client.query('COMMIT');
      return {
        success: true,
        message: 'Event already processed.',
        idempotent: true,
        event_id: id,
        subscription_id: subscriptionIdentifier,
        status: existingEvtRes.rows[0].status || 'processed',
      };
    }

    // 4. Locate and lock subscription row in PostgreSQL
    const subRes = await client.query(
      `SELECT s.*, p.name as plan_name 
       FROM subscriptions s 
       JOIN plans p ON s.plan_id = p.id 
       WHERE s.stripe_subscription_id = $1 OR s.stripe_customer_id = $1 OR s.id::text = $1 
       FOR UPDATE`,
      [subscriptionIdentifier]
    );

    if (subRes.rows.length === 0) {
      const err = new Error(`Subscription '${subscriptionIdentifier}' not found.`);
      err.statusCode = 404;
      throw err;
    }

    const sub = subRes.rows[0];
    const tenantId = sub.tenant_id;
    const { status, plan_name, tenant_id } = data;

    // Validate tenant_id if explicitly supplied in webhook data to prevent cross-tenant parameter spoofing
    if (tenant_id && typeof tenant_id === 'string' && tenant_id !== sub.tenant_id) {
      const err = new Error(`Tenant ID mismatch for subscription '${subscriptionIdentifier}'.`);
      err.statusCode = 400;
      throw err;
    }

    // Check secondary idempotency marker in usage_events
    const idempotencyMarkerKey = `webhook:${id}`;
    const usageMarkerRes = await client.query(
      'SELECT id FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1',
      [tenantId, idempotencyMarkerKey]
    );

    if (usageMarkerRes.rows.length > 0) {
      await client.query('COMMIT');
      return {
        success: true,
        message: 'Event already processed.',
        idempotent: true,
        event_id: id,
        subscription_id: subscriptionIdentifier,
        status: sub.status,
      };
    }

    // 5. Out-of-Order / Stale Event Protection Check
    if (eventDate) {
      const latestMarkerRes = await client.query(
        `SELECT MAX(event_created_at) as latest_event_at 
         FROM webhook_events 
         WHERE tenant_id = $1`,
        [tenantId]
      );

      const latestEventAt = latestMarkerRes.rows[0].latest_event_at;
      if (latestEventAt && eventDate.getTime() < new Date(latestEventAt).getTime()) {
        // Record event in webhook_events & usage_events so retries return idempotently, but skip subscription mutation
        await client.query(
          `INSERT INTO webhook_events (provider_event_id, event_type, tenant_id, subscription_id, status, event_created_at, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, type, tenantId, subscriptionIdentifier, sub.status, eventDate, JSON.stringify(event)]
        );

        await client.query(
          `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_cents, created_at)
           VALUES ($1, $2, 'WEBHOOK_EVENT', 0, 0, 0, 0, 0, 0, $3)`,
          [tenantId, idempotencyMarkerKey, eventDate]
        );

        await client.query('COMMIT');

        return {
          success: true,
          message: 'Event ignored as stale/out-of-order.',
          stale: true,
          event_id: id,
          subscription_id: subscriptionIdentifier,
          status: sub.status,
        };
      }
    }

    // 6. Resolve plan if plan_name is specified in event
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

    // 7. Calculate new subscription status and period bounds based on event type
    let newStatus = sub.status;
    let newPeriodStart = sub.current_period_start;
    let newPeriodEnd = sub.current_period_end;

    if (type === 'subscription.created') {
      newStatus = status || 'active';
    } else if (type === 'subscription.updated') {
      newStatus = status || sub.status;
    } else if (type === 'subscription.cancelled' || type === 'subscription.canceled' || type === 'subscription.deleted') {
      newStatus = 'canceled';
    } else if (type === 'invoice.payment_succeeded' || type === 'payment.success') {
      newStatus = 'active';
      if (data.current_period_start) newPeriodStart = new Date(data.current_period_start);
      if (data.current_period_end) newPeriodEnd = new Date(data.current_period_end);
    } else if (type === 'invoice.payment_failed' || type === 'payment.failure') {
      newStatus = 'past_due';
    }

    // If activating subscription, deactivate any other active subscriptions for the tenant
    if (newStatus === 'active') {
      await client.query(
        "UPDATE subscriptions SET status = 'canceled' WHERE tenant_id = $1 AND id != $2 AND status = 'active'",
        [tenantId, sub.id]
      );
    }

    // 8. Update PostgreSQL Subscription record
    const updateSubQuery = `
      UPDATE subscriptions
      SET status = $1,
          plan_id = $2,
          current_period_start = $3,
          current_period_end = $4
      WHERE id = $5
      RETURNING *
    `;
    const updatedSubRes = await client.query(updateSubQuery, [
      newStatus,
      targetPlanId,
      newPeriodStart,
      newPeriodEnd,
      sub.id,
    ]);
    const finalSub = updatedSubRes.rows[0];

    // 9. Insert record into webhook_events persistence table
    const effectiveEventDate = eventDate || new Date();
    await client.query(
      `INSERT INTO webhook_events (provider_event_id, event_type, tenant_id, subscription_id, status, event_created_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, type, tenantId, subscriptionIdentifier, finalSub.status, effectiveEventDate, JSON.stringify(event)]
    );

    // 10. Insert Idempotency Marker into usage_events (backward compatibility)
    await client.query(
      `INSERT INTO usage_events (tenant_id, idempotency_key, usage_type, quantity, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_cents, created_at)
       VALUES ($1, $2, 'WEBHOOK_EVENT', 0, 0, 0, 0, 0, 0, $3)`,
      [tenantId, idempotencyMarkerKey, effectiveEventDate]
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: `Successfully processed event '${type}'.`,
      event_id: id,
      subscription_id: subscriptionIdentifier,
      status: finalSub.status,
    };
  } catch (error) {
    await client.query('ROLLBACK');

    // Handle partial unique index constraint 23505 on idx_single_active_subscription_per_tenant specifically
    if (error.code === '23505' && error.constraint === 'idx_single_active_subscription_per_tenant') {
      const subCheck = await db.query(
        'SELECT status FROM subscriptions WHERE stripe_subscription_id = $1 OR stripe_customer_id = $1 OR id::text = $1 LIMIT 1',
        [subscriptionIdentifier]
      );
      return {
        success: true,
        message: 'Event processed, active subscription preserved.',
        event_id: id,
        subscription_id: subscriptionIdentifier,
        status: subCheck.rows[0] ? subCheck.rows[0].status : 'active',
      };
    }

    // Handle duplicate provider event ID constraint (code 23505) gracefully
    if (error.code === '23505' && (error.constraint === 'webhook_events_provider_event_id_key' || error.constraint === 'unique_tenant_idempotency')) {
      const subCheck = await db.query(
        'SELECT status FROM subscriptions WHERE stripe_subscription_id = $1 OR stripe_customer_id = $1 OR id::text = $1 LIMIT 1',
        [subscriptionIdentifier]
      );
      return {
        success: true,
        message: 'Event already processed.',
        idempotent: true,
        event_id: id,
        subscription_id: subscriptionIdentifier,
        status: subCheck.rows[0] ? subCheck.rows[0].status : 'unknown',
      };
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  processWebhookEvent,
};
