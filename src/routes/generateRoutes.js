const express = require('express');
const { handleGenerate } = require('../controllers/generateController');

const router = express.Router();

router.post('/generate', handleGenerate);

module.exports = router;
