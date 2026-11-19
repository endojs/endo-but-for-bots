// @ts-check
/**
 * The agent-host adapter loader (M1a W1a.2; architecture D-14): the
 * transient half of the agent-host native resource. Thin on purpose: the
 * daemon bundles this file at installation, so anything here is pinned by
 * the installation's digest; everything else is loaded at run time from
 * the implementation directory, so a provider, channel or tool fix is a
 * file change plus a daemon restart, not a reinstall.
 *
 * `make()` puts the guest prelude on `globalThis` (the implementation
 * imports `guest/lib/*`, which read `M`, `makeExo`, ... from there), then
 * loads `impl/index.js` and returns `makeAdapter({ label, bind, unbind })`.
 *
 * Loading at run time: an installed bundle cannot use `import()` (the
 * bundler rewrites it to a hook it does not provide) nor `import.meta.url`
 * (undefined in the bundle); W1a.2 probe, JOURNAL J-0221. It loads ES
 * modules with Node's `require` (`createRequire`, a builtin exit of the
 * bundle), which evaluates an ES module graph synchronously on Node 22
 * (no top-level await may appear in `impl/`).
 *
 * Where the implementation is (`implDir`): the harness package's
 * `resources/agent-host/impl`, found from the adapter process's entry
 * module (`packages/thixotrope/src/platform/node/adapter-process-entry.js`,
 * `process.argv[1]`): the harness and the core it runs on are siblings in
 * one checkout. Making it an install-time setting needs `installNative`
 * to carry a configuration (JOURNAL J-0221).
 */
import { makeAdapter } from '@endo/thixotrope/native-adapter.js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'path';
import { pid } from 'process';

import { findHarnessRoot } from '../native-layout.js';

export { findHarnessRoot };

/**
 * Load the implementation and build the adapter root.
 *
 * @param {object} [options]
 * @param {string} [options.harnessRoot] the harness package directory
 * @param {Record<string, unknown>} [options.implOptions] passed to
 *   `makeAgentHostImpl` (tests)
 */
export const loadAgentHost = ({
  harnessRoot = findHarnessRoot(),
  implOptions = {},
} = {}) => {
  const requireHere = createRequire(join(harnessRoot, 'package.json'));
  const { installGuestPrelude } = requireHere('./scripts/guest-prelude.js');
  installGuestPrelude();
  const { makeAgentHostImpl } = requireHere(
    './resources/agent-host/impl/index.js',
  );
  const incarnation = `${pid}-${randomBytes(4).toString('hex')}`;
  const { bind, unbind } = makeAgentHostImpl({ incarnation, ...implOptions });
  return makeAdapter({ label: 'AgentHost', bind, unbind });
};
harden(loadAgentHost);

/** The native contract's entry: `make(powers)` returns the adapter root. */
export const make = () => loadAgentHost();
harden(make);
