const { resolveTenant } = require('../services/tenantService');
const { generateTenantInvoice, listTenantInvoices } = require('../services/invoiceService');

/**
 * Controller for GET /api/v1/invoices/current
 * Scoped strictly to the authenticated/request tenant context.
 */
async function handleGetCurrentInvoice(req, res, next) {
  try {
    const tenant = await resolveTenant(req);
    const invoiceData = await generateTenantInvoice(tenant.id);
    return res.status(200).json(invoiceData);
  } catch (error) {
    return next(error);
  }
}

/**
 * Controller for GET /api/v1/invoices
 * Scoped strictly to the authenticated/request tenant context.
 */
async function handleGetInvoices(req, res, next) {
  try {
    const tenant = await resolveTenant(req);
    const invoicesData = await listTenantInvoices(tenant.id);
    return res.status(200).json(invoicesData);
  } catch (error) {
    return next(error);
  }
}

/**
 * Controller for GET /api/v1/invoices/:id
 * Scoped strictly to the authenticated/request tenant context.
 * Returns HTTP 404 Not Found if invoice ID does not belong to the target tenant.
 */
async function handleGetInvoiceById(req, res, next) {
  try {
    const { id } = req.params;
    const tenant = await resolveTenant(req);
    const invoiceData = await generateTenantInvoice(tenant.id);

    if (invoiceData.invoice.id !== id) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Invoice '${id}' not found.`,
      });
    }

    return res.status(200).json(invoiceData);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleGetCurrentInvoice,
  handleGetInvoices,
  handleGetInvoiceById,
};
