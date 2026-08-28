const express = require('express');
const generateRoutes = require('./routes/generateRoutes');

const app = express();

app.use(express.json());

// Base health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Usage Metering & Billing Engine' });
});

// Mount API v1 routes
app.use('/api/v1', generateRoutes);

// Centralized error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.',
  });
});

module.exports = app;
