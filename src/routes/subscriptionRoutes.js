const express = require('express');
const {
  handleCheckout,
  handleGetSubscription,
  handleCancelSubscription,
} = require('../controllers/subscriptionController');

const router = express.Router();

router.get('/subscription', handleGetSubscription);
router.post('/subscription/checkout', handleCheckout);
router.post('/subscription/cancel', handleCancelSubscription);

module.exports = router;
