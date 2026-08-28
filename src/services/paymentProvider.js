const FakePaymentProvider = require('./fakePaymentProvider');

/**
 * Factory function to retrieve the configured payment provider instance.
 * Defaults safely to FakePaymentProvider for zero-cost development and testing.
 * 
 * @returns {Object} Payment provider interface instance
 */
function getPaymentProvider() {
  const providerType = (process.env.PAYMENT_PROVIDER || 'fake').toLowerCase();

  switch (providerType) {
    case 'fake':
      return new FakePaymentProvider();
    default:
      console.warn(`PaymentProvider: Unknown PAYMENT_PROVIDER "${providerType}". Falling back to FakePaymentProvider.`);
      return new FakePaymentProvider();
  }
}

module.exports = {
  getPaymentProvider,
  FakePaymentProvider,
};
