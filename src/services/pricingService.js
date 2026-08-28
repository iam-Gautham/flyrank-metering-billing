/**
 * Pricing rates for AI token categories.
 * Values are stored in nano-cents per token (1 USD cent = 1,000,000 nano-cents).
 * 
 * Rates per 1,000,000 (1M) tokens:
 * - Input tokens: $3.00 / 1M tokens (300 cents / 1M = 300 nano-cents / token)
 * - Cached tokens: $0.75 / 1M tokens (75 cents / 1M = 75 nano-cents / token — 75% discount)
 * - Output tokens: $15.00 / 1M tokens (1,500 cents / 1M = 1,500 nano-cents / token)
 * - Reasoning tokens: $30.00 / 1M tokens (3,000 cents / 1M = 3,000 nano-cents / token)
 */
const TOKEN_RATES_NANO_CENTS = Object.freeze({
  input_tokens: 300,
  cached_tokens: 75,
  output_tokens: 1500,
  reasoning_tokens: 3000,
});

/**
 * Calculates the total cost in integer cents using pure integer monetary arithmetic.
 * No JavaScript floating-point arithmetic is used for monetary values.
 * 
 * @param {Object} tokens
 * @param {number} [tokens.input_tokens=0]
 * @param {number} [tokens.cached_tokens=0]
 * @param {number} [tokens.output_tokens=0]
 * @param {number} [tokens.reasoning_tokens=0]
 * @returns {Object} { costCents, totalNanoCents, breakdownNanoCents }
 */
function calculateTokenCost({ input_tokens = 0, cached_tokens = 0, output_tokens = 0, reasoning_tokens = 0 }) {
  const inputCostNano = input_tokens * TOKEN_RATES_NANO_CENTS.input_tokens;
  const cachedCostNano = cached_tokens * TOKEN_RATES_NANO_CENTS.cached_tokens;
  const outputCostNano = output_tokens * TOKEN_RATES_NANO_CENTS.output_tokens;
  const reasoningCostNano = reasoning_tokens * TOKEN_RATES_NANO_CENTS.reasoning_tokens;

  const totalNanoCents = inputCostNano + cachedCostNano + outputCostNano + reasoningCostNano;

  // Convert nano-cents to integer cents using integer division with rounding to nearest cent:
  // Math.floor((totalNanoCents + 500000) / 1000000)
  const costCents = Math.floor((totalNanoCents + 500000) / 1000000);

  return {
    costCents,
    totalNanoCents,
    breakdownNanoCents: {
      inputCostNano,
      cachedCostNano,
      outputCostNano,
      reasoningCostNano,
    },
  };
}

module.exports = {
  TOKEN_RATES_NANO_CENTS,
  calculateTokenCost,
};
