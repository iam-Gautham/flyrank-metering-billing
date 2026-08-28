const express = require('express');
const { authenticateTenant } = require('../middleware/authMiddleware');
const {
  handleCheckout,
  handleGetSubscription,
  handleCancelSubscription,
} = require('../controllers/subscriptionController');
const { handleReconcileSubscription } = require('../controllers/reconciliationController');

const router = express.Router();

router.post('/subscription/checkout', authenticateTenant, handleCheckout);
router.get('/subscription', authenticateTenant, handleGetSubscription);
router.post('/subscription/cancel', authenticateTenant, handleCancelSubscription);
router.post('/subscription/reconcile', authenticateTenant, handleReconcileSubscription);

module.exports = router;
