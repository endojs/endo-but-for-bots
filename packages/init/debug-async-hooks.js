// debug-async-hooks.js - export lockdown with async_hooks patch for debugging

// Install async_hooks patches for Node.js debugging in lockdown mode
// This is a specialized entrypoint for debugging scenarios where async_hooks
// compatibility is needed (e.g., for debuggers in older Node.js versions).
// Note: This patch may not work in Node.js 24+.
import './src/node-async_hooks-patch.js';

// Install our HandledPromise global.
import './pre-remoting.js';

/**
 * @deprecated Import these names from `@endo/lockdown` directly. `@endo/init`
 * plain-re-exports the `@endo/lockdown/commit-debug.js` surface
 * (endojs/endo-but-for-bots#543): importing a name through it rather than from
 * the package that originally exports it is discouraged, and this re-export is
 * slated for removal in a future major version. Only importing names through
 * `@endo/init/debug-async-hooks.js` is deprecated; the module's purpose is the
 * lockdown side effect of `import '@endo/init/debug-async-hooks.js'`, which is
 * unaffected.
 */
export * from '@endo/lockdown/commit-debug.js';
