// @ts-check

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

/**
 * A stand-in `SandboxFactory` for the daemon's sandbox-engine shell tests.
 * It reports one usable backend and records, in the `audit` directory it is
 * handed as powers, each slice the shell formula asks it to make and each
 * slice it disposes.  Its slices do not spawn: these tests pin the daemon's
 * provisioning, persistence, and revival of the engine, not process
 * execution, which `@endo/sandbox`'s own suite covers.
 *
 * @param {any} audit
 */
export const make = async audit => {
  /** @param {string} name */
  const bump = async name => {
    const before = await E(audit).maybeReadText(name);
    await E(audit).writeText(name, `${BigInt(before || '0') + 1n}`);
  };
  return Far('StubSandboxFactory', {
    listBackends: () => harden([{ name: 'stub', available: true }]),
    /** @param {any} options */
    make: async options => {
      await bump('makes');
      const { mounts, ...rest } = options;
      await E(audit).writeText(
        'last-make',
        JSON.stringify({
          ...rest,
          mounts: mounts.map(({ innerPath, mode }) => ({ innerPath, mode })),
        }),
      );
      return Far('StubSandboxSlice', {
        spawn: async () => {
          throw Error('stub sandbox slice does not spawn');
        },
        dispose: () => bump('disposals'),
      });
    },
  });
};
harden(make);
