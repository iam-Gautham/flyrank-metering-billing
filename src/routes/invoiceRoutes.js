const express = require('express');
const {
  handleGetCurrentInvoice,
  handleGetInvoices,
  handleGetInvoiceById,
} = require('../controllers/invoiceController');

const router = express.Router();

router.get('/invoices/current', handleGetCurrentInvoice);
router.get('/invoices', handleGetInvoices);
router.get('/invoices/:id', handleGetInvoiceById);

module.exports = router;
