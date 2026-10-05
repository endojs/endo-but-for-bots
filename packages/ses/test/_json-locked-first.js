// Locks the universal `JSON` global before `lockdown`, with the very value
// `lockdown` would install. Only first-wins shims such as `@endo/sturdyref` are
// exempt from redefinition, so `lockdown` must still refuse this binding.

Object.defineProperty(globalThis, 'JSON', {
  value: JSON,
  writable: false,
  enumerable: false,
  configurable: false,
});
