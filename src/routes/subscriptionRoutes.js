const express = require('express');
const { handleCheckout } = require('../controllers/subscriptionController');

const router = express.Router();

router.post('/subscription/checkout', handleCheckout);

module.exports = router;
