// @ts-check

// Select the lockdown taming level before `@endo/init` runs `lockdown()`.
//
// `@endo/init` (imported next in main.js) hands off to `@endo/lockdown`,
// whose `lockdown()` reads a `LOCKDOWN_OPTIONS` global (or env var) — a JSON
// options bag — to choose taming. `@endo/preact-container` requires
// `overrideTaming: 'severe'`: Preact instantiates function components by
// assigning `component.constructor = type`, which hits the SES "override
// mistake" under the default 'moderate' (and 'min') taming. 'severe' makes
// `Object.prototype` properties overridable so that assignment succeeds.
// Monaco and the rest of the bundle are verified compatible (see
// test/monaco-lockdown).
//
// IMPORTANT: this module must be the FIRST import in the app entry and have
// no imports of its own. ES module imports are hoisted and evaluated in
// source order before the importing module's body, so this assignment runs
// before `@endo/init` evaluates `lockdown()`.
globalThis.LOCKDOWN_OPTIONS = JSON.stringify({ overrideTaming: 'severe' });

// Some Android WebViews expose non-configurable legacy caller/arguments on
// these Web IDL constructors. SES cannot delete those properties. A strict
// forwarding constructor keeps the native implementation and brand checks,
// but makes the legacy constructor unreachable through its prototype.
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
