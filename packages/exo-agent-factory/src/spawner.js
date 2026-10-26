// @ts-check

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const ChildAgentSpawnerInterface = M.interface('ChildAgentSpawner', {
  spawn: M.callWhen(M.string())
    .optional(
      M.splitRecord(
        {},
        {
          instructions: M.string(),
          endowments: M.recordOf(M.string(), M.any()),
        },
      ),
    )
    .returns(M.splitRecord({ name: M.string(), handle: M.remotable() })),
  stop: M.callWhen(M.string()).returns(M.undefined()),
  list: M.callWhen().returns(M.arrayOf(M.string())),
});

/**
 * Adapt a bound child-agent factory to the small recursive topology a harness
 * needs: one derived namespace per logical child, one agent in that namespace,
 * and an optional spawner endowment made over the child's namespace.
 *
 * The derived namespace is the ownership boundary. Revoking it removes the
 * child and every descendant depth first, so an adapter never needs a host or
 * a second directory from which to reconstruct its tree.
 *
 * @param {object} options
 * @param {any} options.factory
 * @param {string} [options.spawnerEndowmentName]
 * @param {(spawner: any) => any | Promise<any>} [options.makeSpawnerEndowment]
 */
export const makeChildAgentSpawner = ({
  factory,
  spawnerEndowmentName,
  makeSpawnerEndowment,
}) => {
  const makeSpawner = childFactory =>
    makeChildAgentSpawner({
      factory: childFactory,
      ...(spawnerEndowmentName ? { spawnerEndowmentName } : {}),
      ...(makeSpawnerEndowment ? { makeSpawnerEndowment } : {}),
    });

  return makeExo('ChildAgentSpawner', ChildAgentSpawnerInterface, {
    /**
     * @param {string} name
     * @param {{ instructions?: string, endowments?: Record<string, any> }} [options]
     */
    async spawn(name, options = {}) {
      const childFactory = await E(factory).attenuate(name, {});
      try {
        const childSpawner = makeSpawner(childFactory);
        const endowments = { ...(options.endowments ?? {}) };
        if (spawnerEndowmentName !== undefined) {
          !(spawnerEndowmentName in endowments) ||
            Fail`Child endowment ${q(spawnerEndowmentName)} is reserved for its spawner`;
          endowments[spawnerEndowmentName] = makeSpawnerEndowment
            ? await makeSpawnerEndowment(childSpawner)
            : childSpawner;
        }
        const { handle } = await E(childFactory).create(
          'agent',
          harden({
            ...(options.instructions
              ? { instructions: options.instructions }
              : {}),
            ...(Object.keys(endowments).length > 0 ? { endowments } : {}),
          }),
        );
        return harden({ name, handle });
      } catch (error) {
        await E(factory)
          .revokeDerived(name)
          .catch(() => {});
        throw error;
      }
    },

    /** @param {string} name */
    stop(name) {
      return E(factory).revokeDerived(name);
    },

    async list() {
      const derived = await E(factory).listDerived();
      return harden(derived.map(({ name }) => name));
    },
  });
};
harden(makeChildAgentSpawner);
