const { getDemoTenant } = require('../services/tenantService');
const { getTenantUsage } = require('../services/tenantUsageService');

/**
 * Controller for GET /api/v1/usage
 */
async function handleGetUsage(req, res, next) {
  try {
    const tenant = await getDemoTenant();
    const usageSummary = await getTenantUsage(tenant.id);
    return res.status(200).json(usageSummary);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleGetUsage,
};
