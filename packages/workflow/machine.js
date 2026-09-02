// @ts-check

// Thunk module: the pure kernel's public surface at the path consumers
// import (`@endo/workflow/machine.js`), physically present so the
// legacy directory-walk resolution (no `exports`-map support) lands
// here too. Re-exports everything `./src/machine.js` exports.
export * from './src/machine.js';
