const express = require('express');
const { authenticateTenant } = require('../middleware/authMiddleware');
const { handleGetUsage } = require('../controllers/usageController');

const router = express.Router();

router.get('/usage', authenticateTenant, handleGetUsage);

module.exports = router;
