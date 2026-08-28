const { test } = require('node:test');
const assert = require('node:assert');
const { getPaymentProvider, FakePaymentProvider } = require('../src/services/paymentProvider');

test('FakePaymentProvider - creates checkout session locally with deterministic IDs', async () => {
  const provider = new FakePaymentProvider();
  const session = await provider.createCheckoutSession({
    tenantId: '32e8849a-6f0a-4639-9c57-30da0f98ca6f',
    planId: 'plan-pro-uuid',
    successUrl: 'http://localhost:3000/success',
    cancelUrl: 'http://localhost:3000/cancel',
    customerEmail: 'dev@flyrank.com',
  });

  assert.ok(session.id.startsWith('fake_checkout_'));
  assert.ok(session.customerId.startsWith('fake_cust_'));
  assert.ok(session.subscriptionId.startsWith('fake_sub_'));
  assert.strictEqual(session.status, 'open');
  assert.strictEqual(session.customerEmail, 'dev@flyrank.com');
  assert.ok(session.url.includes('/fake-checkout/'));
});

test('FakePaymentProvider - retrieves created subscription', async () => {
  const provider = new FakePaymentProvider();
  const session = await provider.createCheckoutSession({
    tenantId: '32e8849a-6f0a-4639-9c57-30da0f98ca6f',
    planId: 'plan-pro-uuid',
  });

  const subscription = await provider.getSubscription(session.subscriptionId);
  assert.strictEqual(subscription.id, session.subscriptionId);
  assert.strictEqual(subscription.status, 'active');
  assert.strictEqual(subscription.planId, 'plan-pro-uuid');
  assert.ok(subscription.currentPeriodStart);
  assert.ok(subscription.currentPeriodEnd);
});

test('FakePaymentProvider - cancels subscription', async () => {
  const provider = new FakePaymentProvider();
  const session = await provider.createCheckoutSession({
    tenantId: '32e8849a-6f0a-4639-9c57-30da0f98ca6f',
    planId: 'plan-pro-uuid',
  });

  const canceledSub = await provider.cancelSubscription(session.subscriptionId);
  assert.strictEqual(canceledSub.status, 'canceled');
  assert.ok(canceledSub.canceledAt);

  const fetchedSub = await provider.getSubscription(session.subscriptionId);
  assert.strictEqual(fetchedSub.status, 'canceled');
});

test('FakePaymentProvider - processes simulated webhook events', async () => {
  const provider = new FakePaymentProvider();
  const event = await provider.processEvent({
    type: 'invoice.payment_succeeded',
    data: { amount_paid: 2900 },
  });

  assert.ok(event.id.startsWith('fake_evt_'));
  assert.strictEqual(event.type, 'invoice.payment_succeeded');
  assert.strictEqual(event.data.amount_paid, 2900);
  assert.strictEqual(event.processed, true);
});

test('PaymentProvider Factory - defaults safely to FakePaymentProvider when PAYMENT_PROVIDER is unset or fake', () => {
  const originalEnv = process.env.PAYMENT_PROVIDER;

  try {
    delete process.env.PAYMENT_PROVIDER;
    const defaultProvider = getPaymentProvider();
    assert.ok(defaultProvider instanceof FakePaymentProvider);
    assert.strictEqual(defaultProvider.name, 'fake');

    process.env.PAYMENT_PROVIDER = 'fake';
    const fakeProvider = getPaymentProvider();
    assert.ok(fakeProvider instanceof FakePaymentProvider);

    process.env.PAYMENT_PROVIDER = 'unknown_provider';
    const fallbackProvider = getPaymentProvider();
    assert.ok(fallbackProvider instanceof FakePaymentProvider);
  } finally {
    if (originalEnv) {
      process.env.PAYMENT_PROVIDER = originalEnv;
    } else {
      delete process.env.PAYMENT_PROVIDER;
    }
  }
});
