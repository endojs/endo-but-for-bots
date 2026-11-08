// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const ConnectionInterface = M.interface('DevReviewConnection', {
  start: M.callWhen(M.record()).returns(M.record()),
  status: M.callWhen(M.string()).returns(M.record()),
  setRemaining: M.callWhen(M.string(), M.nat()).returns(M.undefined()),
  cancel: M.callWhen(M.string(), M.string()).returns(M.undefined()),
});

/**
 * A formula-backed connection reacquires ephemeral factory/run facets after
 * restart. It exposes only this initiating conversation's factory runs.
 * @param {any} powers - guest with service and factory-id in its pet store
 */
export const make = async powers => {
  const service = await E(powers).lookup('service');
  const fid = await E(powers).lookup('factory-id');
  const ownRun = async runId => {
    const run = await E(service).run(runId);
    if ((await E(run).status()).factory !== fid)
      throw Error('Run belongs to another factory');
    return run;
  };
  return makeExo('DevReviewConnection', ConnectionInterface, {
    start: async options => {
      const factory = await E(service).factory(fid);
      const { runId } = await E(factory).start(options);
      return harden({ runId });
    },
    status: async runId => E(await ownRun(runId)).status(),
    setRemaining: async (runId, remaining) => {
      const run = await ownRun(runId);
      if ((await E(run).status()).paused)
        throw Error('Resume the workflow before changing its budget');
      const control = await E(service).control(runId);
      const port = await E(control).port('initiator');
      const seq = await E(port).submit(
        harden({ type: 'set-remaining', value: { remaining } }),
      );
      // A port can journal an ignored event (or queue it while paused). Check
      // this specific event's result, not a racy before/after state snapshot.
      const [entry] = await E(run).journal({ from: seq, to: seq + 1n });
      if (entry?.fired?.context.remaining !== remaining)
        throw Error(
          'Budget update was not applied; inspect the workflow status',
        );
    },
    cancel: async (runId, reason) => {
      await ownRun(runId);
      await E(await E(service).control(runId)).cancel(reason);
    },
  });
};
harden(make);
