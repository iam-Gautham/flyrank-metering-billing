require('dotenv').config();

/**
 * Validates and resolves application configuration settings.
 * Throws a descriptive Error if required parameters are malformed or missing.
 */
function validateConfig() {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT configuration: '${process.env.PORT}'. Must be a valid port number (1-65535).`);
  }

  const poolMax = process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 20;
  if (isNaN(poolMax) || poolMax <= 0) {
    throw new Error(`Invalid DB_POOL_MAX configuration: '${process.env.DB_POOL_MAX}'. Must be a positive integer.`);
  }

  const maxRetries = process.env.DB_MAX_RETRIES ? parseInt(process.env.DB_MAX_RETRIES, 10) : 3;
  if (isNaN(maxRetries) || maxRetries < 0) {
    throw new Error(`Invalid DB_MAX_RETRIES configuration: '${process.env.DB_MAX_RETRIES}'. Must be a non-negative integer.`);
  }

  return {
    env: process.env.NODE_ENV || 'development',
    port,
    paymentProvider: process.env.PAYMENT_PROVIDER || 'fake',
    db: {
      url: process.env.DATABASE_URL || null,
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME || 'metering_billing',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      poolMax,
      maxRetries,
    },
  };
}

module.exports = {
  validateConfig,
};
