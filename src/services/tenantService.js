const db = require('../db');

/**
 * Fetch default Demo Tenant from database.
 * Returns tenant object with id and name, or throws an error if not found.
 */
async function getDemoTenant() {
  const result = await db.query(
    "SELECT id, name FROM tenants WHERE name = 'Demo Tenant' LIMIT 1"
  );
  if (result.rows.length === 0) {
    throw new Error("Demo Tenant not found in database. Please run seed script.");
  }
  return result.rows[0];
}

/**
 * Resolves tenant context from request header `x-tenant-id` or falls back to Demo Tenant.
 * Throws HTTP 404 error if an explicit x-tenant-id header is provided but not found in DB.
 *
 * @param {Object} [req]
 * @returns {Promise<Object>}
 */
async function resolveTenant(req) {
  const tenantIdHeader = req && req.headers ? req.headers['x-tenant-id'] : null;
  if (tenantIdHeader) {
    const res = await db.query('SELECT id, name FROM tenants WHERE id = $1', [tenantIdHeader]);
    if (res.rows.length === 0) {
      const error = new Error(`Tenant '${tenantIdHeader}' not found.`);
      error.statusCode = 404;
      error.userFacing = true;
      throw error;
    }
    return res.rows[0];
  }
  return getDemoTenant();
}

module.exports = {
  getDemoTenant,
  resolveTenant,
};
