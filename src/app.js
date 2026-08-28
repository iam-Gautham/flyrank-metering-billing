const express = require('express');
const db = require('./db');
const logger = require('./utils/logger');
const generateRoutes = require('./routes/generateRoutes');
const usageRoutes = require('./routes/usageRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const invoiceRoutes = require('./routes/invoiceRoutes');

const app = express();

let isShuttingDown = false;

/**
 * Flag server shutdown state to reject new HTTP traffic gracefully.
 */
app.setShuttingDown = (flag) => {
  isShuttingDown = flag;
};

// Shutdown guard middleware
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({
      error: 'Service Unavailable',
      message: 'Server is undergoing graceful shutdown. Please retry request.',
    });
  }
  next();
});

// Enforce 1MB request body payload limit for API security
app.use(express.json({ limit: '1mb' }));

// Base health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Usage Metering & Billing Engine' });
});

// Liveness Probe Endpoint (Checks if process is running)
app.get('/health/liveness', (req, res) => {
  return res.status(200).json({ status: 'ok', liveness: 'alive' });
});

// Readiness Probe Endpoint (Checks if service can serve traffic)
app.get('/health/readiness', async (req, res) => {
  try {
    await db.query('SELECT 1');
    return res.status(200).json({ status: 'ok', readiness: 'ready', database: 'connected' });
  } catch (err) {
    return res.status(503).json({ status: 'error', readiness: 'not_ready', database: 'disconnected', message: 'Database connectivity failed.' });
  }
});

// Standardized container readiness and health check probe endpoints (Backward Compatibility)
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    return res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (err) {
    return res.status(503).json({ status: 'error', database: 'disconnected', message: 'Database connection failed.' });
  }
});

app.get('/api/v1/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    return res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (err) {
    return res.status(503).json({ status: 'error', database: 'disconnected', message: 'Database connection failed.' });
  }
});

// Mount API v1 routes
app.use('/api/v1', generateRoutes);
app.use('/api/v1', usageRoutes);
app.use('/api/v1', subscriptionRoutes);
app.use('/api/v1', webhookRoutes);
app.use('/api/v1', invoiceRoutes);

// Centralized error handling middleware
app.use((err, req, res, next) => {
  // Handle Express JSON body parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON payload format.',
    });
  }

  // Handle Express 413 Payload Too Large error
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request payload exceeds maximum size limit of 1MB.',
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const isClientError = statusCode >= 400 && statusCode < 500;

  // Log unhandled internal server errors internally
  if (!isClientError) {
    logger.error('app', `Unhandled Internal Server Error: ${err.message}`, { stack: err.stack });
  }

  // Sanitize internal server error messages to prevent leaking stack traces or database details
  const responseMessage = isClientError || err.userFacing
    ? (err.message || 'Client request error.')
    : 'An unexpected internal server error occurred.';

  const errorTitle = statusCode === 400 ? 'Bad Request'
    : statusCode === 404 ? 'Not Found'
    : statusCode === 429 ? 'Too Many Requests'
    : statusCode === 502 ? 'Bad Gateway'
    : statusCode === 413 ? 'Payload Too Large'
    : 'Internal Server Error';

  return res.status(statusCode).json({
    error: errorTitle,
    message: responseMessage,
  });
});

module.exports = app;
