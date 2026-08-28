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

module.exports = {
  getDemoTenant,
};
