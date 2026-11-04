// @ts-check

import { Fail, q } from '@endo/errors';

const PRICE_FIELDS = harden([
  'inputPerMillion',
  'outputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
]);

// One thousand micro-dollars is $0.001. Smaller non-zero per-million prices
// are more likely to be natural dollar values entered in the wrong unit than
// a useful provider price; free usage remains expressible as zero.
const MINIMUM_NONZERO_PRICE = 1000;

/**
 * Parse `INFERENCE_PROVIDER_MODEL_PRICES`: a JSON object from model id to a
 * record of integer micro-dollar prices per million tokens.
 *
 * @param {string | undefined} text
 */
export const parseInferenceProviderModelPrices = text => {
  if (text === undefined) return harden({});
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw Fail`INFERENCE_PROVIDER_MODEL_PRICES is not JSON: ${error}`;
  }
  (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ||
    Fail`INFERENCE_PROVIDER_MODEL_PRICES must be an object of model prices`;
  for (const [model, price] of Object.entries(parsed)) {
    (price &&
      typeof price === 'object' &&
      !Array.isArray(price) &&
      Object.hasOwn(price, 'inputPerMillion') &&
      Object.hasOwn(price, 'outputPerMillion') &&
      Object.entries(price).every(
        ([name, value]) =>
          PRICE_FIELDS.includes(name) &&
          Number.isSafeInteger(value) &&
          (value === 0 || Number(value) >= MINIMUM_NONZERO_PRICE),
      )) ||
      Fail`INFERENCE_PROVIDER_MODEL_PRICES has an invalid micro-dollar price for ${q(model)}`;
  }
  return harden(parsed);
};
harden(parseInferenceProviderModelPrices);
