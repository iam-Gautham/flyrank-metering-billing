const express = require('express');
const { handleGetUsage } = require('../controllers/usageController');

const router = express.Router();

router.get('/usage', handleGetUsage);

module.exports = router;
