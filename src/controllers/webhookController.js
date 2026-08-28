const { processWebhookEvent } = require('../services/webhookService');

/**
 * Controller for POST /api/v1/webhooks/payment
 */
async function handlePaymentWebhook(req, res, next) {
  try {
    const result = await processWebhookEvent(req.body);
    return res.status(200).json(result);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message,
      });
    }
    if (error.statusCode === 404) {
      return res.status(404).json({
        error: 'Not Found',
        message: error.message,
      });
    }
    return next(error);
  }
}

module.exports = {
  handlePaymentWebhook,
};
