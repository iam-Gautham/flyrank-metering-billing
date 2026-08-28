const db = require('../db');

/**
 * Express authentication & authorization middleware for tenant API endpoints.
 * Authenticates request via Authorization header (Bearer <token/tenant_id>), X-API-Key, or x-tenant-id.
 * Falls back to default Demo Tenant for unauthenticated local development requests.
 * Attaches authoritative tenant object { id, name } to req.tenant.
 * Returns HTTP 401 Unauthorized for invalid or unauthenticated credentials.
 */
async function authenticateTenant(req, res, next) {
  try {
    let credential = null;

    // 1. Check Authorization Bearer header
    const authHeader = req.get('Authorization') || req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      credential = authHeader.substring(7).trim();
    }

    // 2. Check X-API-Key or x-tenant-id header
    if (!credential) {
      credential = req.get('X-API-Key') || req.get('x-tenant-id') || req.headers['x-api-key'] || req.headers['x-tenant-id'];
    }

    // 3. If explicit credential is provided, validate against database
    if (credential && typeof credential === 'string' && credential.trim() !== '') {
      const cleanCredential = credential.trim();
      const result = await db.query(
        'SELECT id, name FROM tenants WHERE id::text = $1 OR name = $1 LIMIT 1',
        [cleanCredential]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid authentication credential or tenant identity.',
        });
      }

      req.tenant = result.rows[0];
      return next();
    }

    // 4. Default fallback to Demo Tenant if no explicit credential header is supplied
    const demoResult = await db.query("SELECT id, name FROM tenants WHERE name = 'Demo Tenant' LIMIT 1");
    if (demoResult.rows.length === 0) {
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Demo Tenant not found in database.',
      });
    }

    req.tenant = demoResult.rows[0];
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  authenticateTenant,
};
