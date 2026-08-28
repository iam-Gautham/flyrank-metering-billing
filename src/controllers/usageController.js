const { getTenantUsage } = require('../services/tenantUsageService');

/**
 * Controller for GET /api/v1/usage
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleGetUsage(req, res, next) {
  try {
    const tenant = req.tenant;
    const usageSummary = await getTenantUsage(tenant.id);
    return res.status(200).json(usageSummary);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleGetUsage,
};
