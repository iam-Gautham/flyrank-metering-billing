require('dotenv').config();
const app = require('./app');
const db = require('./db');
const { validateConfig } = require('./config');
const logger = require('./utils/logger');

let server;
let isShuttingDown = false;

/**
 * Validates configuration and database connectivity before binding to the HTTP port.
 * Exits with non-zero status if environment configuration is malformed or PostgreSQL is unreachable.
 */
async function startServer() {
  try {
    // 1. Validate environment configuration
    const config = validateConfig();
    logger.info('server', 'Configuration validated successfully.', { env: config.env, port: config.port });

    // 2. Verify PostgreSQL connectivity before opening HTTP port
    await db.query('SELECT 1');
    logger.info('server', 'PostgreSQL database connectivity verified successfully.');

    // 3. Start Express HTTP server
    server = app.listen(config.port, () => {
      logger.info('server', `Server running on port ${config.port}`);
    });
    return server;
  } catch (err) {
    logger.error('server', `Fatal Startup Error: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Initiates graceful shutdown sequence on process termination signals.
 * Rejects new HTTP traffic, drains in-flight requests, and closes PostgreSQL connection pool cleanly.
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn('server', `Shutdown sequence already in progress. Ignoring duplicate ${signal} signal.`);
    return;
  }

  isShuttingDown = true;
  logger.info('server', `Received ${signal}. Starting graceful shutdown...`);

  if (app.setShuttingDown) {
    app.setShuttingDown(true);
  }

  if (server) {
    server.close(async () => {
      logger.info('server', 'HTTP server closed.');
      try {
        await db.pool.end();
        logger.info('server', 'PostgreSQL connection pool drained.');
        process.exit(0);
      } catch (err) {
        logger.error('server', `Error during PostgreSQL connection pool shutdown: ${err.message}`);
        process.exit(1);
      }
    });
  } else {
    try {
      await db.pool.end();
      process.exit(0);
    } catch (err) {
      process.exit(1);
    }
  }

  // Force exit after 10s if shutdown hangs
  setTimeout(() => {
    logger.error('server', 'Graceful shutdown timed out after 10s. Forcing process exit.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('server', 'Unhandled Promise Rejection', { reason: reason ? reason.message || reason : 'unknown' });
});

process.on('uncaughtException', (err) => {
  logger.error('server', `Uncaught Exception thrown: ${err.message}`);
  gracefulShutdown('uncaughtException');
});

// Auto-start server when executed directly as main script
if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  gracefulShutdown,
};
