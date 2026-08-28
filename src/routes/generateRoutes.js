const express = require('express');
const { authenticateTenant } = require('../middleware/authMiddleware');
const { handleGenerate } = require('../controllers/generateController');

const router = express.Router();

router.post('/generate', authenticateTenant, handleGenerate);

module.exports = router;
