const express = require('express');
const generateRoutes = require('./routes/generateRoutes');
const usageRoutes = require('./routes/usageRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

app.use(express.json());

// Base health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Usage Metering & Billing Engine' });
});

// Mount API v1 routes
app.use('/api/v1', generateRoutes);
app.use('/api/v1', usageRoutes);
app.use('/api/v1', subscriptionRoutes);
app.use('/api/v1', webhookRoutes);

// Centralized error handling middleware
app.use((err, req, res, next) => {
  // Handle Express JSON body parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON payload format.',
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  const isClientError = statusCode >= 400 && statusCode < 500;

  // Log unhandled internal server errors internally
  if (!isClientError) {
    console.error('Unhandled Internal Server Error:', err);
  }

  // Sanitize internal server error messages to prevent leaking stack traces or database details
  const responseMessage = isClientError || err.userFacing
    ? (err.message || 'Client request error.')
    : 'An unexpected internal server error occurred.';

  const errorTitle = statusCode === 400 ? 'Bad Request'
    : statusCode === 404 ? 'Not Found'
    : statusCode === 429 ? 'Too Many Requests'
    : statusCode === 502 ? 'Bad Gateway'
    : 'Internal Server Error';

  return res.status(statusCode).json({
    error: errorTitle,
    message: responseMessage,
  });
});

module.exports = app;
