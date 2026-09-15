// @ts-check
import { E } from '@endo/far';
import harden from '@endo/harden';

/**
 * The durable half of a manual-persistence pair: holds a live reference to an
 * ephemeral resource vat, and rebuilds it whenever there isn't one.
 *
 * See designs/manual-persistence-vats.md. A manager keeps policy and desired
 * state in its own orthogonally persistent heap; the vat this keeps holds the
 * mechanism — the host capability, the connections, the buffers — and is
 * expected to die with the host process that hosted it.
 *
 * The keeper does not stamp generations. It does not need to: the ephemeral
 * vat's death is a retirement, and the hub's session epoch already makes every
 * stale reference into it break loudly rather than reach its successor. That
 * is the property being relied on here, so `provide` treats a broken probe as
 * "build a new one" rather than trying to tell incarnations apart itself.
 *
 * Self-contained, because a manager ships this factory's source into its own
 * vat, where only E, Far and harden are in scope.
 *
 * @param {object} options
 * @param {any} options.vats a ThixotropeWorkerController
 * @param {string} options.source evaluated in each new vat; its result is the
 *   adapter the manager talks to
 * @param {() => any} [options.endowments] fresh endowments for each
 *   incarnation — host resources, and anything else the adapter needs. Called
 *   per build, because a capability that was fine for a dead incarnation may
 *   not be the one this incarnation should get.
 * @param {(adapter: any) => Promise<void>} [options.restore] push the desired
 *   state into a newly built adapter. Runs before `provide` resolves, so a
 *   caller never sees an adapter that has not been told what it is for.
 * @param {(adapter: any) => Promise<unknown>} [options.probe] cheap liveness
 *   check; defaults to asking the adapter for its method names, which any
 *   remotable answers and a tombstone breaks.
 * @param {string} [options.debugLabel]
 */
export const makeEphemeralVatKeeper = ({
  vats,
  source,
  endowments = () => ({}),
  restore = async () => {},
  // eslint-disable-next-line no-underscore-dangle
  probe = adapter => E(adapter).__getMethodNames__(),
  debugLabel = 'resource',
}) => {
  /** @type {any} */
  let adapter;
  /** @type {any} */
  let worker;
  /** @type {Promise<any> | undefined} */
  let building;
  let incarnations = 0n;

  const build = async () => {
    const created = await E(vats).createEphemeralWorker(debugLabel);
    const evaluator = await E(created).getEvaluator();
    const built = await E(evaluator).evaluate(source, harden(endowments()));
    // Restore before publishing the reference: a manager that hands out a
    // half-configured adapter has invented a state its desired set never
    // described.
    await restore(built);
    worker = created;
    adapter = built;
    incarnations += 1n;
    return built;
  };

  return harden({
    /**
     * A live adapter, building one if the last is gone. Concurrent callers
     * share one build rather than racing to create two vats for one resource.
     */
    provide: async () => {
      if (building !== undefined) return building;
      if (adapter !== undefined) {
        const current = adapter;
        try {
          await probe(current);
          return current;
        } catch (_error) {
          // A broken probe means the incarnation is retired, which is the
          // expected end of one, not a fault to report.
          adapter = undefined;
          worker = undefined;
        }
      }
      building = build().finally(() => {
        building = undefined;
      });
      return building;
    },

    /**
     * Forget the current incarnation without waiting to discover it is dead.
     *
     * Note what this does *not* do: re-issue whatever call failed. A broken
     * call is an uncertain call — the adapter may have performed its effect
     * before dying — so whether repeating it is safe is known only to the
     * operation, never here.
     */
    invalidate: () => {
      adapter = undefined;
      worker = undefined;
    },

    /** Retire the current incarnation now, releasing whatever it holds. */
    retire: async () => {
      const dying = worker;
      adapter = undefined;
      worker = undefined;
      if (dying === undefined) return false;
      await E(dying).retire();
      return true;
    },

    status: () =>
      harden({
        incarnations,
        live: adapter !== undefined,
        building: building !== undefined,
      }),
  });
};
harden(makeEphemeralVatKeeper);
