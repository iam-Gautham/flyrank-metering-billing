const { generateTenantInvoice, listTenantInvoices } = require('../services/invoiceService');

/**
 * Controller for GET /api/v1/invoices/current
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleGetCurrentInvoice(req, res, next) {
  try {
    const tenant = req.tenant;
    const invoiceData = await generateTenantInvoice(tenant.id);
    return res.status(200).json(invoiceData);
  } catch (error) {
    if (error.userFacing) {
      return res.status(error.statusCode || 400).json({
        error: 'Bad Request',
        message: error.message,
      });
    }
    return next(error);
  }
}

/**
 * Controller for GET /api/v1/invoices
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 */
async function handleGetInvoices(req, res, next) {
  try {
    const tenant = req.tenant;
    const invoicesData = await listTenantInvoices(tenant.id);
    return res.status(200).json(invoicesData);
  } catch (error) {
    if (error.userFacing) {
      return res.status(error.statusCode || 400).json({
        error: 'Bad Request',
        message: error.message,
      });
    }
    return next(error);
  }
}

/**
 * Controller for GET /api/v1/invoices/:id
 * Uses authenticated tenant identity attached by authenticateTenant middleware.
 * Guarantees cross-tenant access returns HTTP 404 Not Found without leaking financial data.
 */
async function handleGetInvoiceById(req, res, next) {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim() === '') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invoice ID is required.',
      });
    }

    const tenant = req.tenant;
    const invoiceData = await generateTenantInvoice(tenant.id);
    if (invoiceData.invoice.id !== id.trim()) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Invoice '${id.trim()}' not found.`,
      });
    }

    return res.status(200).json(invoiceData);
  } catch (error) {
    if (error.userFacing) {
      return res.status(error.statusCode || 400).json({
        error: 'Bad Request',
        message: error.message,
      });
    }
    return next(error);
  }
}

module.exports = {
  handleGetCurrentInvoice,
  handleGetInvoices,
  handleGetInvoiceById,
};
