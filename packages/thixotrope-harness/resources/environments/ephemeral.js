// @ts-check
/**
 * The environments adapter loader (`designs/m6-interfaces.md` D-M6-1,
 * 5.2): the transient half of the environments native resource. Thin, as
 * the agent host's loader (`resources/agent-host/ephemeral.js`, whose
 * header says why): the daemon bundles this file at installation; the
 * implementation is loaded at run time from `impl/` with Node's `require`,
 * so a runner or git fix is a file change and a daemon restart, not a
 * reinstall.
 *
 * `make()` puts the guest prelude on `globalThis` (the implementation
 * imports `guest/lib/guards/environments.js`), loads `impl/index.js` and
 * returns `makeAdapter({ label, bind, unbind })`.
 */
import { makeAdapter } from '@endo/thixotrope/native-adapter.js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pid } from 'node:process';

import { findHarnessRoot } from '../agent-host/ephemeral.js';

/**
 * Load the implementation and build the adapter root.
 * @param {object} [options]
 * @param {string} [options.harnessRoot] the harness package directory
 * @param {Record<string, unknown>} [options.implOptions] passed to
 *   `makeEnvironmentsImpl` (tests)
 */
export const loadEnvironments = ({
  harnessRoot = findHarnessRoot(),
  implOptions = {},
} = {}) => {
  const requireHere = createRequire(join(harnessRoot, 'package.json'));
  const { installGuestPrelude } = requireHere('./scripts/guest-prelude.js');
  installGuestPrelude();
  const { makeEnvironmentsImpl } = requireHere(
    './resources/environments/impl/index.js',
  );
  const incarnation = `${pid}-${randomBytes(4).toString('hex')}`;
  const { bind, unbind } = makeEnvironmentsImpl({
    incarnation,
    ...implOptions,
  });
  return makeAdapter({ label: 'Environments', bind, unbind });
};
harden(loadEnvironments);

/** The native contract's entry: `make(powers)` returns the adapter root. */
export const make = () => loadEnvironments();
harden(make);
