// @ts-check

/**
 * Deep-freeze under SES `lockdown()` (where `harden` is a global), falling back
 * to a shallow `Object.freeze` where it is absent (e.g. the browser test
 * harness). Mirrors the `deepFreeze` helper in `@endo/preact-container`.
 *
 * Internal to this package — not exposed in the `exports` map.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export const freeze = value =>
  typeof globalThis !== 'undefined' && typeof globalThis.harden === 'function'
    ? globalThis.harden(value)
    : Object.freeze(value);
freeze(freeze);
