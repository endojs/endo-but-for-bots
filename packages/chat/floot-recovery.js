// @ts-check

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

/**
 * A view-local journal reader. Selection epochs fence late reads and actions;
 * the session itself remains the authority for whether resolution is safe.
 * @param {{ notify: () => void, isBusy: () => boolean }} options
 */
export const makeFlootRecovery = ({ notify, isBusy }) => {
  let epoch = 0n;
  /** @type {any} */
  let selected = null;
  let canResolve = false;
  let resolving = false;
  /** @type {any} */
  let state = {
    status: 'unavailable',
    message: 'No session selected.',
    turns: [],
  };
  const refresh = async () => {
    const facet = selected;
    if (!facet || resolving) return;
    epoch += 1n;
    const generation = epoch;
    const valid = () => generation === epoch;
    canResolve = false;
    state = { ...state, status: 'loading', message: 'Loading turn journal…' };
    notify();
    try {
      // Standard CapTP introspection, not a guessed backend method.
      // eslint-disable-next-line no-underscore-dangle
      const methods = await E(facet).__getMethodNames__();
      if (!valid()) return;
      if (!methods.includes('getTurns')) {
        state = {
          status: 'unavailable',
          message: 'This session does not expose a turn journal.',
          turns: [],
        };
      } else {
        const [turns, current, capacity] = await Promise.all([
          E(facet).getTurns(),
          methods.includes('getCurrentTurn')
            ? E(facet).getCurrentTurn()
            : Promise.resolve(true),
          methods.includes('getJournalStatus')
            ? E(facet).getJournalStatus()
            : Promise.resolve(null),
        ]);
        if (!valid()) return;
        if (
          !Array.isArray(turns) ||
          turns.some(
            turn =>
              !turn ||
              typeof turn.turnId !== 'string' ||
              typeof turn.state !== 'string' ||
              (turn.error !== undefined && typeof turn.error !== 'string') ||
              (turn.resolution !== undefined &&
                typeof turn.resolution !== 'string') ||
              (turn.tools !== undefined && !Array.isArray(turn.tools)) ||
              (turn.activity !== undefined && !Array.isArray(turn.activity)),
          )
        )
          throw Error('Invalid journal response');
        canResolve = methods.includes('resolveTurn') && !current;
        state = {
          status: 'ready',
          message: '',
          turns,
          capacity,
          current: Boolean(current),
        };
      }
    } catch {
      if (!valid()) return;
      state = {
        status: 'unavailable',
        message:
          'Turn journal unavailable. No recovery action is safe here; inspect the service and storage before retrying.',
        turns: [],
      };
    }
    if (valid()) notify();
  };
  return harden({
    select(/** @type {any} */ facet, unavailable = '') {
      epoch += 1n;
      selected = facet;
      canResolve = false;
      resolving = false;
      state = {
        status: 'unavailable',
        message: unavailable || 'No session selected.',
        turns: [],
      };
      notify();
      return refresh();
    },
    refresh,
    getState() {
      return harden({
        ...state,
        blocked: state.turns.some(
          (/** @type {any} */ turn) =>
            turn.state === 'outcome-unknown' && !turn.resolution,
        ),
        resolving,
        canResolve:
          canResolve && !isBusy() && !resolving && state.status === 'ready',
      });
    },
    async resolve(
      /** @type {string} */ turnId,
      /** @type {string} */ note,
      /** @type {boolean} */ confirmed,
    ) {
      if (
        !confirmed ||
        !note.trim() ||
        !canResolve ||
        isBusy() ||
        resolving ||
        state.status !== 'ready'
      )
        return;
      const turn = state.turns.find(
        (/** @type {any} */ item) => item.turnId === turnId,
      );
      if (!turn || turn.state !== 'outcome-unknown' || turn.resolution) return;
      const generation = epoch;
      const facet = selected;
      resolving = true;
      notify();
      try {
        // Recheck remotely immediately before mutation, without trusting a
        // potentially stale browser liveness snapshot. resolveTurn also fences
        // concurrent starts and unsettled tool effects at its own boundary.
        const current = await E(facet).getCurrentTurn();
        if (generation !== epoch || isBusy()) return;
        if (current) throw Error('A turn is active. Wait for it to settle.');
        await E(facet).resolveTurn(turnId, note.trim());
      } catch (error) {
        if (generation === epoch) {
          state = {
            ...state,
            message: `Resolution refused: ${error instanceof Error ? error.message : String(error)}`,
          };
          canResolve = false;
        }
        return;
      } finally {
        if (generation === epoch) {
          resolving = false;
          notify();
        }
      }
      if (generation === epoch) await refresh();
    },
  });
};
harden(makeFlootRecovery);
