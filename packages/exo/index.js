export { initEmpty } from './src/exo-makers.js';

// makeExo, defineExoClass, defineExoClassKit are re-exported from
// types-index so they get typed declarations that infer method types
// from InterfaceGuard (see types-index.d.ts).

export * from './types-index.js';

export { GET_INTERFACE_GUARD } from './src/get-interface.js';
