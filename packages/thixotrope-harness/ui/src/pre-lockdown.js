// @ts-check
/**
 * The first module of the page bundle (imported first by `main.js`; no
 * imports of its own, so it runs before `@endo/init` locks the realm down).
 *
 * Copied from `packages/chat/pre-lockdown.js` of this repository (D-M3-5),
 * unchanged in substance:
 * - `overrideTaming: 'severe'`: Preact assigns `constructor` (and copies
 *   vnodes that carry an own `constructor` key) on plain objects, which the
 *   SES override mistake refuses under 'moderate' and 'min';
 * - some Android WebViews expose non-configurable legacy `caller` /
 *   `arguments` on these Web IDL constructors, which SES cannot delete; a
 *   strict forwarding constructor keeps the native implementation and its
 *   brand checks.
 */
globalThis.LOCKDOWN_OPTIONS = JSON.stringify({ overrideTaming: 'severe' });

for (const name of ['TextEncoder', 'TextDecoder', 'URLSearchParams', 'URL']) {
  const globals = /** @type {Record<string, any>} */ (globalThis);
  const Native = globals[name];
  if (
    Native &&
    Object.getOwnPropertyDescriptor(Native, 'arguments')?.configurable === false
  ) {
    const Strict = {
      // Constructors must be constructable; method shorthand is not.
      // eslint-disable-next-line object-shorthand
      [name]: function (...args) {
        if (!new.target) throw TypeError(`${name} requires new`);
        return Reflect.construct(Native, args, new.target);
      },
    }[name];
    for (const key of Reflect.ownKeys(Native)) {
      if (
        !['arguments', 'caller', 'prototype', 'name', 'length'].includes(
          String(key),
        )
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(Native, key);
        if (descriptor) Object.defineProperty(Strict, key, descriptor);
      }
    }
    Object.defineProperty(Strict, 'prototype', { value: Native.prototype });
    Object.defineProperty(Native.prototype, 'constructor', {
      value: Strict,
      writable: true,
      configurable: true,
    });
    globals[name] = Strict;
  }
}
