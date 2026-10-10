// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const SeqShape = M.bigint();

const ConnectionInterface = M.interface('DeployConnection', {
  start: M.callWhen().optional(M.record()).returns(M.record()),
  describe: M.callWhen().returns(M.record()),
  status: M.callWhen(M.string()).returns(M.record()),
  explain: M.callWhen(M.string()).returns(M.record()),
  journal: M.callWhen(M.string())
    .optional(M.splitRecord({}, { from: SeqShape, to: SeqShape }))
    .returns(M.arrayOf(M.record())),
  help: M.call().returns(M.string()),
});

/**
 * A formula-backed, proposal-only connection to one deploy-workflow factory:
 * the shape a session holds instead of the factory facet itself.
 *
 * The factory facet also carries `with` and `revoke`, and revoking cancels
 * every live run — authority the design reserves for the operator and the
 * service holder, not for the model that proposed a deployment. A run
 * observer is a derived object with no formula behind it, so a session
 * cannot keep one by name across turns either; this connection re-reaches a
 * run by id through the service and admits only runs of its own factories.
 *
 * One connection serves every session the factory host copies it into, so
 * "its own factories' runs" is the whole deploy history of this host, not
 * one session's: any holder can observe (and, with a matching `requestId`
 * and params, adopt) a run another holder started. That is the right scope
 * for machine-admin sessions, which share one owner; a preset that isolates
 * principals from each other needs a connection per principal.
 *
 * The powers guest holds `service` and `factory-ids` (oldest first; the
 * newest starts runs). A chart version bump re-mints the factory and appends
 * its id, so runs of the retired factory stay observable while the old
 * factory is deliberately left un-revoked.
 *
 * @param {any} powers - guest with `service` and `factory-ids` in its pet
 *   store
 */
export const make = async powers => {
  const service = await E(powers).lookup('service');
  const factoryIds = async () => {
    /** @type {string[]} */
    const ids = await E(powers).lookup('factory-ids');
    if (!Array.isArray(ids) || ids.length === 0) {
      throw Error('No deploy factory is bound to this connection');
    }
    return ids;
  };
  const currentFactory = async () => {
    const ids = await factoryIds();
    return E(service).factory(ids[ids.length - 1]);
  };
  const ownRun = async runId => {
    const ids = await factoryIds();
    const run = await E(service).run(runId);
    const { factory } = await E(run).status();
    if (!ids.includes(factory)) {
      throw Error('Run belongs to another factory');
    }
    return run;
  };
  return makeExo('DeployConnection', ConnectionInterface, {
    // Data params in, a run id out. Extra endowments a caller might attach
    // are dropped here: a proposal carries no capability of its own.
    start: async ({ params = harden({}), requestId = undefined } = {}) => {
      const factory = await currentFactory();
      const { runId } = await E(factory).start(
        harden({
          params,
          ...(requestId !== undefined ? { requestId } : {}),
        }),
      );
      return harden({ runId });
    },
    describe: async () => E(await currentFactory()).describe(),
    status: async runId => E(await ownRun(runId)).status(),
    explain: async runId => E(await ownRun(runId)).explain(),
    journal: async (runId, options = harden({})) =>
      E(await ownRun(runId)).journal(options),
    help: () =>
      'Deploy connection: start({ params, requestId? }) -> { runId } proposes ' +
      'a run of the bound deploy chart (its approval form goes to the ' +
      "operator's inbox, not to the caller); describe() -> the factory " +
      'record; status(runId), explain(runId), and journal(runId, { from?, ' +
      "to? }) observe runs of this connection's factories, whoever started " +
      'them.',
  });
};
harden(make);
