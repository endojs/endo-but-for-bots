// Generic preamble for all shims.

import '@endo/lockdown';
import '@endo/base64/shim.js';
import '@endo/promise-kit/shim.js';

/**
 * @deprecated Import these names from `@endo/lockdown` directly. `@endo/init`
 * plain-re-exports the `@endo/lockdown` surface (endojs/endo-but-for-bots#543):
 * importing a name through it rather than from the package that originally
 * exports it is discouraged, and this re-export is slated for removal in a
 * future major version. Only importing names through `@endo/init/pre.js` is
 * deprecated; the module's purpose is the shim side effect of
 * `import '@endo/init/pre.js'`, which is unaffected.
 */
export * from '@endo/lockdown';
