const { test } = require('node:test');
const assert = require('node:assert');
const { TOKEN_RATES_NANO_CENTS, calculateTokenCost } = require('../src/services/pricingService');

test('pricingService - normal input token cost calculation', () => {
  // 1,000,000 input tokens * 300 nano-cents = 300,000,000 nano-cents = 300 cents ($3.00)
  const res = calculateTokenCost({ input_tokens: 1000000, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
  assert.strictEqual(res.costCents, 300);
  assert.strictEqual(res.totalNanoCents, 300000000);
});

test('pricingService - discounted cached token cost calculation', () => {
  // 1,000,000 cached tokens * 75 nano-cents = 75,000,000 nano-cents = 75 cents ($0.75)
  // 75% discount vs normal input (300 vs 75 nano-cents)
  const res = calculateTokenCost({ input_tokens: 0, cached_tokens: 1000000, output_tokens: 0, reasoning_tokens: 0 });
  assert.strictEqual(res.costCents, 75);
  assert.strictEqual(res.totalNanoCents, 75000000);

  // Compare cached rate directly to input rate to verify 75% discount
  assert.strictEqual(TOKEN_RATES_NANO_CENTS.cached_tokens, TOKEN_RATES_NANO_CENTS.input_tokens * 0.25);
});

test('pricingService - output token cost calculation', () => {
  // 1,000,000 output tokens * 1,500 nano-cents = 1,500,000,000 nano-cents = 1,500 cents ($15.00)
  const res = calculateTokenCost({ input_tokens: 0, cached_tokens: 0, output_tokens: 1000000, reasoning_tokens: 0 });
  assert.strictEqual(res.costCents, 1500);
});

test('pricingService - reasoning token cost calculation', () => {
  // 1,000,000 reasoning tokens * 3,000 nano-cents = 3,000,000,000 nano-cents = 3,000 cents ($30.00)
  const res = calculateTokenCost({ input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 1000000 });
  assert.strictEqual(res.costCents, 3000);
});

test('pricingService - combined token categories cost calculation', () => {
  // input: 50,000 * 300 = 15,000,000 nano-cents
  // cached: 20,000 * 75 = 1,500,000 nano-cents
  // output: 10,000 * 1,500 = 15,000,000 nano-cents
  // reasoning: 5,000 * 3,000 = 15,000,000 nano-cents
  // total = 46,500,000 nano-cents = 47 cents (rounded to nearest cent)
  const res = calculateTokenCost({
    input_tokens: 50000,
    cached_tokens: 20000,
    output_tokens: 10000,
    reasoning_tokens: 5000,
  });

  assert.strictEqual(res.totalNanoCents, 46500000);
  assert.strictEqual(res.costCents, 47);
});

test('pricingService - pure integer monetary arithmetic without floating-point rounding errors', () => {
  // 3,000 tokens of input (900,000 nano-cents) + 1,000 tokens of cached (75,000 nano-cents) = 975,000 nano-cents
  // (975,000 + 500,000) / 1,000,000 = 1 cent
  const res = calculateTokenCost({ input_tokens: 3000, cached_tokens: 1000, output_tokens: 0, reasoning_tokens: 0 });
  assert.strictEqual(res.totalNanoCents, 975000);
  assert.strictEqual(res.costCents, 1);
  assert.strictEqual(typeof res.costCents, 'number');
  assert.ok(Number.isInteger(res.costCents));
});
