const express = require('express');
const { authenticateTenant } = require('../middleware/authMiddleware');
const {
  handleGetCurrentInvoice,
  handleGetInvoices,
  handleGetInvoiceById,
} = require('../controllers/invoiceController');

const router = express.Router();

router.get('/invoices/current', authenticateTenant, handleGetCurrentInvoice);
router.get('/invoices', authenticateTenant, handleGetInvoices);
router.get('/invoices/:id', authenticateTenant, handleGetInvoiceById);

module.exports = router;
