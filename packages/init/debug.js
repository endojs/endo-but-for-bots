// debug.js - call lockdown with default Agoric shims

// Install our HandledPromise global.
import './pre-remoting.js';

/**
 * @deprecated Import these names from `@endo/lockdown` directly. `@endo/init`
 * plain-re-exports the `@endo/lockdown/commit-debug.js` surface
 * (endojs/endo-but-for-bots#543): importing a name through it rather than from
 * the package that originally exports it is discouraged, and this re-export is
 * slated for removal in a future major version. Only importing names through
 * `@endo/init/debug.js` is deprecated; the module's purpose is the lockdown
 * side effect of `import '@endo/init/debug.js'`, which is unaffected.
 */
export * from '@endo/lockdown/commit-debug.js';
