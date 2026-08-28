const { getDemoTenant } = require('../services/tenantService');
const { findUsageEvent, recordUsageEvent } = require('../services/usageService');

/**
 * Validates that a value is a non-negative integer.
 */
function isNonNegativeInteger(val) {
  return typeof val === 'number' && Number.isInteger(val) && val >= 0;
}

/**
 * Controller for POST /api/v1/generate
 */
async function handleGenerate(req, res, next) {
  try {
    // 1. Validate Idempotency-Key header
    const rawIdempotencyKey = req.get('Idempotency-Key') || req.headers['idempotency-key'];
    if (!rawIdempotencyKey || typeof rawIdempotencyKey !== 'string' || rawIdempotencyKey.trim() === '') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing or empty Idempotency-Key header.',
      });
    }
    const idempotencyKey = rawIdempotencyKey.trim();

    // 2. Validate token fields in request body
    const { input_tokens, cached_tokens, output_tokens, reasoning_tokens } = req.body || {};
    const invalidFields = [];
    if (!isNonNegativeInteger(input_tokens)) invalidFields.push('input_tokens');
    if (!isNonNegativeInteger(cached_tokens)) invalidFields.push('cached_tokens');
    if (!isNonNegativeInteger(output_tokens)) invalidFields.push('output_tokens');
    if (!isNonNegativeInteger(reasoning_tokens)) invalidFields.push('reasoning_tokens');

    if (invalidFields.length > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Invalid or missing token parameters: ${invalidFields.join(', ')}. All token values must be non-negative integers.`,
      });
    }

    // 3. Fetch Demo Tenant
    const tenant = await getDemoTenant();

    // 4. Check application-level idempotency
    const existingEvent = await findUsageEvent(tenant.id, idempotencyKey);
    if (existingEvent) {
      return res.status(200).json({
        success: true,
        result: {
          text: 'This is a simulated AI-generated response from FlyRank.',
        },
        usage: {
          input_tokens: existingEvent.input_tokens,
          cached_tokens: existingEvent.cached_tokens,
          output_tokens: existingEvent.output_tokens,
          reasoning_tokens: existingEvent.reasoning_tokens,
          total_tokens: existingEvent.quantity,
        },
      });
    }

    // 5. Calculate total tokens
    const total_tokens = input_tokens + cached_tokens + output_tokens + reasoning_tokens;

    // 6. Record usage event (handles DB unique constraint conflict safely)
    const event = await recordUsageEvent({
      tenantId: tenant.id,
      idempotencyKey,
      usageType: 'AI_TOKENS',
      quantity: total_tokens,
      inputTokens: input_tokens,
      cachedTokens: cached_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
      costCents: 0,
    });

    // 7. Return success response
    return res.status(200).json({
      success: true,
      result: {
        text: 'This is a simulated AI-generated response from FlyRank.',
      },
      usage: {
        input_tokens: event.input_tokens,
        cached_tokens: event.cached_tokens,
        output_tokens: event.output_tokens,
        reasoning_tokens: event.reasoning_tokens,
        total_tokens: event.quantity,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleGenerate,
};
