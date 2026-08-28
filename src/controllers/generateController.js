const { getDemoTenant } = require('../services/tenantService');
const { recordUsageEvent } = require('../services/usageService');

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
    const { input_tokens, cached_tokens, output_tokens, reasoning_tokens } = req.body || {};

    // Validate token fields
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

    // Fetch Demo Tenant
    const tenant = await getDemoTenant();

    // Calculate total tokens
    const total_tokens = input_tokens + cached_tokens + output_tokens + reasoning_tokens;

    // Record usage event
    await recordUsageEvent({
      tenantId: tenant.id,
      usageType: 'AI_TOKENS',
      quantity: total_tokens,
      inputTokens: input_tokens,
      cachedTokens: cached_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
      costCents: 0,
    });

    // Return success response with simulated generation result and usage details
    return res.status(200).json({
      success: true,
      result: {
        text: 'This is a simulated AI-generated response from FlyRank.',
      },
      usage: {
        input_tokens,
        cached_tokens,
        output_tokens,
        reasoning_tokens,
        total_tokens,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleGenerate,
};
