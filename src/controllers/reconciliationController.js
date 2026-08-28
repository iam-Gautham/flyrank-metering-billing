const { reconcileTenantSubscription } = require('../services/reconciliationService');

/**
 * Controller for POST /api/v1/subscription/reconcile
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleReconcileSubscription(req, res, next) {
  try {
    const tenant = req.tenant;
    const result = await reconcileTenantSubscription(tenant.id);
    return res.status(200).json({
      success: true,
      reconciliation: result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleReconcileSubscription,
};
