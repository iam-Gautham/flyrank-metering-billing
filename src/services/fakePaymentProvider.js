const crypto = require('crypto');

/**
 * Fake Payment Provider implementation for zero-cost local development and offline testing.
 * Makes zero network requests, requires no API keys or accounts, and charges no real money.
 */
class FakePaymentProvider {
  constructor() {
    this.name = 'fake';
    this.subscriptions = new Map();
    this.checkoutSessions = new Map();
  }

  /**
   * Simulates creating a checkout session.
   */
  async createCheckoutSession({ tenantId, planId, successUrl, cancelUrl, customerEmail }) {
    if (!tenantId || !planId) {
      throw new Error('FakePaymentProvider: tenantId and planId are required.');
    }

    const sessionId = `fake_checkout_${crypto.randomBytes(8).toString('hex')}`;
    const customerId = `fake_cust_${tenantId.slice(0, 8)}`;
    const subscriptionId = `fake_sub_${crypto.randomBytes(8).toString('hex')}`;

    const session = {
      id: sessionId,
      tenantId,
      planId,
      customerId,
      subscriptionId,
      successUrl: successUrl || 'http://localhost:3000/success',
      cancelUrl: cancelUrl || 'http://localhost:3000/cancel',
      customerEmail: customerEmail || 'demo@example.com',
      status: 'open',
      url: `http://localhost:3000/fake-checkout/${sessionId}`,
      created: Math.floor(Date.now() / 1000),
    };

    this.checkoutSessions.set(sessionId, session);

    // Seed mock active subscription record in fake memory
    this.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      tenantId,
      planId,
      customerId,
      status: 'active',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      canceledAt: null,
    });

    return session;
  }

  /**
   * Simulates retrieving a subscription.
   */
  async getSubscription(subscriptionId) {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      throw new Error(`FakePaymentProvider: Subscription ${subscriptionId} not found.`);
    }
    return { ...sub };
  }

  /**
   * Simulates cancelling a subscription.
   */
  async cancelSubscription(subscriptionId) {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      throw new Error(`FakePaymentProvider: Subscription ${subscriptionId} not found.`);
    }
    sub.status = 'canceled';
    sub.canceledAt = new Date().toISOString();
    this.subscriptions.set(subscriptionId, sub);
    return { ...sub };
  }

  /**
   * Simulates processing a webhook event.
   */
  async processEvent(eventPayload = {}) {
    const eventId = eventPayload.id || `fake_evt_${crypto.randomBytes(8).toString('hex')}`;
    return {
      id: eventId,
      type: eventPayload.type || 'fake.payment_intent.succeeded',
      data: eventPayload.data || {},
      processed: true,
      processedAt: new Date().toISOString(),
    };
  }

  /**
   * Generates a deterministic simulated lifecycle event for testing.
   */
  generateLifecycleEvent({ id, type, subscriptionId, status, planName, created }) {
    const eventId = id || `fake_evt_${crypto.randomBytes(8).toString('hex')}`;
    return {
      id: eventId,
      type: type || 'subscription.updated',
      created: created || Math.floor(Date.now() / 1000),
      data: {
        subscription_id: subscriptionId,
        status: status || 'active',
        plan_name: planName,
      },
    };
  }

  /**
   * Generates a deterministic simulated invoice / payment event for testing.
   */
  generateInvoiceEvent({ id, type, subscriptionId, customerId, status, periodStart, periodEnd, created }) {
    const eventId = id || `fake_evt_inv_${crypto.randomBytes(8).toString('hex')}`;
    return {
      id: eventId,
      type: type || 'invoice.payment_succeeded',
      created: created || Math.floor(Date.now() / 1000),
      data: {
        subscription_id: subscriptionId,
        customer_id: customerId,
        status: status || 'paid',
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
    };
  }

  /**
   * Generates a deterministic simulated subscription renewal event.
   */
  generateRenewalEvent({ id, subscriptionId, periodStart, periodEnd, created }) {
    return this.generateInvoiceEvent({
      id: id || `fake_evt_renew_${crypto.randomBytes(8).toString('hex')}`,
      type: 'invoice.payment_succeeded',
      subscriptionId,
      status: 'paid',
      periodStart,
      periodEnd,
      created,
    });
  }

  /**
   * Generates a deterministic simulated payment failure event.
   */
  generatePaymentFailureEvent({ id, subscriptionId, customerId, created }) {
    return this.generateInvoiceEvent({
      id: id || `fake_evt_fail_${crypto.randomBytes(8).toString('hex')}`,
      type: 'invoice.payment_failed',
      subscriptionId,
      customerId,
      status: 'uncollectible',
      created,
    });
  }

  /**
   * Generates a deterministic simulated payment recovery event.
   */
  generatePaymentRecoveryEvent({ id, subscriptionId, customerId, periodStart, periodEnd, created }) {
    return this.generateInvoiceEvent({
      id: id || `fake_evt_recovery_${crypto.randomBytes(8).toString('hex')}`,
      type: 'invoice.payment_succeeded',
      subscriptionId,
      customerId,
      status: 'paid',
      periodStart,
      periodEnd,
      created,
    });
  }
}

module.exports = FakePaymentProvider;
