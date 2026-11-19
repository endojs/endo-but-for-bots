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
// Distinct builtin specifiers keep the bundled loader's exits separate
// from the path and process exits in native-layout.js.
import { randomBytes } from 'crypto';
import { createRequire } from 'module';
import { join } from 'path';
import { pid } from 'process';

import { findHarnessRoot } from '../native-layout.js';

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
