// @ts-check

/**
 * Require a fixture value to exist before inspecting its fields. AVA's value
 * assertions return booleans, so they do not narrow nullable TypeScript values.
 * @template T
 * @param {T} value
 * @returns {NonNullable<T>}
 */
export const defined = value => {
  if (value === null || value === undefined) {
    throw Error('Expected a defined test fixture value');
  }
  return value;
};
harden(defined);
