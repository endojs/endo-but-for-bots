// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { makeAccountJournal } from './account-oracle.js';
import { makeDelegatedRunner } from './delegated-runner.js';

/**
 * Delegated-runner caplet: the retained `make-unconfined` entrypoint of one
 * delegated runner (`delegated-runner.js`).
 *
 * Its powers are a namespace of its own, which holds:
 *
 *   - `backend` — the hosted backend factory it attenuates. Setup re-points
 *     the name on every run, since an adapter mints its backend again.
 *   - `runner-limits` — a stored value, the operator's limits. Read for every
 *     call, so rewriting it changes the runner with no restart.
 *   - the runner's state (`runner-state-v1-*`): whether it was revoked, and
 *     which sessions are its own. A revoked runner revives revoked, and a
 *     restart neither forgets its sessions nor frees their slots.
 *
 * The value is the **operator's** facet: `revoke()`, `getStatus()`, and
 * `runner()`, which answers the factory itself. Setup binds that in a formula
 * of its own (`delegated-runner-facet-module.js`), and that is what is handed
 * out: a holder of the runner has no path to this.
 *
 * @param {import('@endo/eventual-send').ERef<any>} powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = async (powers, _context, { env } = {}) => {
  const runnerId = env?.RUNNER_ID ?? Fail`Runner has no RUNNER_ID`;
  /** @param {string} name */
  const provide = async name => {
    (await E(powers).has(name)) || Fail`Runner has no ${name} bound`;
    return E(powers).lookup(name);
  };
  const { factory, admin } = makeDelegatedRunner({
    runnerId,
    provideFactory: () => provide('backend'),
    provideLimits: () => provide('runner-limits'),
    journal: makeAccountJournal({ powers, prefix: 'runner-state-v1-' }),
  });
  return makeExo(
    'RunnerKit',
    M.interface('RunnerKit', {
      runner: M.call().returns(M.remotable()),
      revoke: M.callWhen().returns(M.record()),
      getStatus: M.callWhen().returns(M.record()),
      help: M.call().optional(M.string()).returns(M.string()),
    }),
    {
      runner: () => factory,
      revoke: () => admin.revoke(),
      getStatus: () => admin.getStatus(),
      /** @param {string} [methodName] */
      help(methodName) {
        if (methodName === 'runner') {
          return 'runner() — The runner itself, a HostedBackendFactory: what is handed to a holder. Setup binds it as a formula of its own.';
        }
        return methodName === undefined
          ? `Runner kit for "${runnerId}": runner(), revoke(), getStatus(). The operator’s; a holder of the runner cannot reach it.`
          : admin.help(methodName);
      },
    },
  );
};
harden(make);
