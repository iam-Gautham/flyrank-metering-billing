const { getDemoTenant } = require('../services/tenantService');
const { createSubscriptionCheckout } = require('../services/checkoutService');
const { getTenantSubscriptionDetails, cancelTenantActiveSubscription } = require('../services/subscriptionService');

/**
 * Controller for POST /api/v1/subscription/checkout
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

    const tenant = await getDemoTenant();
    const result = await createSubscriptionCheckout({
      tenantId: tenant.id,
      planName: plan_name.trim(),
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
 */
async function handleGetSubscription(req, res, next) {
  try {
    const tenant = await getDemoTenant();
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
 */
async function handleCancelSubscription(req, res, next) {
  try {
    const tenant = await getDemoTenant();
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
