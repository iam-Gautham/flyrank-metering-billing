const { createSubscriptionCheckout } = require('../services/checkoutService');
const { getTenantSubscriptionDetails, cancelTenantActiveSubscription } = require('../services/subscriptionService');

/**
 * Controller for POST /api/v1/subscription/checkout
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleCheckout(req, res, next) {
  try {
    const { plan_name } = req.body || {};

    if (!plan_name || typeof plan_name !== 'string' || plan_name.trim() === '') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'plan_name is required.',
      });
    }

    if (plan_name.length > 100) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'plan_name exceeds maximum length of 100 characters.',
      });
    }

    const rawIdempotencyKey = req.get('Idempotency-Key') || req.headers['idempotency-key'];
    const idempotencyKey = rawIdempotencyKey && typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : null;

    const tenant = req.tenant;
    const result = await createSubscriptionCheckout({
      tenantId: tenant.id,
      planName: plan_name.trim(),
      idempotencyKey,
    });

    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({
        error: 'Not Found',
        message: error.message,
      });
    }
    return next(error);
  }
}

/**
 * Controller for GET /api/v1/subscription
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleGetSubscription(req, res, next) {
  try {
    const tenant = req.tenant;
    const result = await getTenantSubscriptionDetails(tenant.id);
    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({
        error: 'Not Found',
        message: error.message,
      });
    }
    return next(error);
  }
}

/**
 * Controller for POST /api/v1/subscription/cancel
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleCancelSubscription(req, res, next) {
  try {
    const tenant = req.tenant;
    const result = await cancelTenantActiveSubscription(tenant.id);
    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({
        error: 'Not Found',
        message: error.message,
      });
    }
    return next(error);
  }
}

module.exports = {
  handleCheckout,
  handleGetSubscription,
  handleCancelSubscription,
};
