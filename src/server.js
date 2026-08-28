require('dotenv').config();
const app = require('./app');
const db = require('./db');

const PORT = process.env.PORT || 3000;

let server;

/**
 * Validates database connectivity before binding to the HTTP port.
 * Exits with non-zero status if PostgreSQL is unreachable.
 */
async function startServer() {
  try {
    // 1. Verify PostgreSQL connectivity before opening HTTP port
    await db.query('SELECT 1');
    console.log('PostgreSQL database connectivity verified successfully.');

    // 2. Start Express HTTP server
    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    return server;
  } catch (err) {
    console.error('Fatal Startup Error: Database connectivity check failed on launch:', err.message);
    process.exit(1);
  }
}

/**
 * Initiates graceful shutdown sequence on process termination signals.
 * Stops accepting new HTTP connections and drains PostgreSQL connection pool.
 */
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  if (server) {
    server.close(async () => {
      console.log('HTTP server closed.');
      try {
        await db.pool.end();
        console.log('PostgreSQL connection pool drained.');
        process.exit(0);
      } catch (err) {
        console.error('Error during PostgreSQL connection pool shutdown:', err);
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
    console.error('Graceful shutdown timed out after 10s. Forcing process exit.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
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
