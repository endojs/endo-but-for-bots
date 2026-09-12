// @ts-check

import { E } from '@endo/eventual-send';
import harden from '@endo/harden';

const policies = harden(['off', 'public-internet']);

/**
 * Operator-only view controller. No network-policy mutator is exposed to the
 * model; remote policy enforcement and request CAS remain session duties.
 * @param {{ notify: () => void, isBusy: () => boolean }} options
 */
export const makeFlootNetwork = ({ notify, isBusy }) => {
  let epoch = 0n;
  /** @type {any} */
  let selected = null;
  let changing = false;
  /** @type {string[]} */
  let methods = [];
  /** @type {any} */
  let state = {
    status: 'unavailable',
    message: 'No session selected.',
    policy: null,
    supportedPolicies: [],
  };
  const refresh = async () => {
    if (!selected || changing || state.status === 'loading') return;
    epoch += 1n;
    const generation = epoch;
    const facet = selected;
    state = {
      ...state,
      status: 'loading',
      message: 'Reading sandbox network policy…',
    };
    notify();
    try {
      // eslint-disable-next-line no-underscore-dangle
      const available = await E(facet).__getMethodNames__();
      if (generation !== epoch) return;
      methods = available;
      if (!methods.includes('getNetworkPolicy')) throw Error('Unsupported');
      const [value, current] = await Promise.all([
        E(facet).getNetworkPolicy(),
        methods.includes('getCurrentTurn')
          ? E(facet).getCurrentTurn()
          : Promise.resolve(true),
      ]);
      if (generation !== epoch) return;
      if (
        !value ||
        !Array.isArray(value.supportedPolicies) ||
        value.supportedPolicies.some(policy => !policies.includes(policy)) ||
        (value.policy !== null &&
          !value.supportedPolicies.includes(value.policy)) ||
        value.applies !== 'next-turn' ||
        (value.pendingPolicy !== undefined &&
          !value.supportedPolicies.includes(value.pendingPolicy)) ||
        (value.error !== undefined && typeof value.error !== 'string') ||
        (value.request &&
          (typeof value.request.id !== 'string' ||
            !value.request.id ||
            !policies.includes(value.request.policy) ||
            typeof value.request.reason !== 'string'))
      )
        throw Error('Invalid policy response');
      if (
        !value.supportedPolicies.length ||
        (value.policy === null && !value.pendingPolicy)
      ) {
        state = {
          status: 'unavailable',
          message:
            'This backend does not support enforced sandbox network policies. No off policy is implied.',
          policy: null,
          supportedPolicies: [],
        };
      } else {
        state = {
          ...value,
          status: 'ready',
          message: value.error || '',
          current: Boolean(current),
        };
      }
    } catch {
      if (generation !== epoch) return;
      state = {
        status: 'unavailable',
        message:
          'Sandbox network policy unavailable. Enforcement could not be verified; no policy change is possible here.',
        policy: null,
        supportedPolicies: [],
      };
    }
    if (generation === epoch) notify();
  };
  const canChange = () =>
    state.status === 'ready' && !state.current && !isBusy() && !changing;
  /** @param {() => Promise<unknown>} operation */
  const mutate = async operation => {
    if (!canChange()) return;
    const generation = epoch;
    const facet = selected;
    changing = true;
    notify();
    try {
      const current = await E(facet).getCurrentTurn();
      if (generation !== epoch || isBusy()) return;
      if (current)
        throw Error(
          'A turn is active. Stop it and wait for it to settle before changing network access.',
        );
      await operation();
    } catch (error) {
      if (generation === epoch)
        state = {
          ...state,
          status: 'error',
          policy: null,
          message: `Policy change refused: ${error instanceof Error ? error.message : String(error)}`,
        };
      return;
    } finally {
      if (generation === epoch) {
        changing = false;
        notify();
      }
    }
    if (generation === epoch) await refresh();
  };
  return harden({
    select(/** @type {any} */ facet, unavailable = '') {
      epoch += 1n;
      selected = facet;
      changing = false;
      methods = [];
      state = {
        status: 'unavailable',
        message: unavailable || 'No session selected.',
        policy: null,
        supportedPolicies: [],
      };
      notify();
      return refresh();
    },
    refresh,
    getState: () =>
      harden({
        ...state,
        changing,
        blocked: Boolean(state.pendingPolicy) || state.status === 'error',
        canSet: canChange() && methods.includes('setNetworkPolicy'),
        canResolve:
          canChange() &&
          !state.pendingPolicy &&
          methods.includes('resolveNetworkPolicyRequest'),
      }),
    set(/** @type {string} */ policy) {
      if (
        !methods.includes('setNetworkPolicy') ||
        !state.supportedPolicies.includes(policy) ||
        (state.pendingPolicy && policy !== state.pendingPolicy)
      )
        return Promise.resolve();
      const facet = selected;
      return mutate(() => E(facet).setNetworkPolicy(policy));
    },
    resolve(
      /** @type {string} */ id,
      /** @type {boolean} */ approve,
      /** @type {string} */ note,
    ) {
      if (
        !methods.includes('resolveNetworkPolicyRequest') ||
        state.pendingPolicy ||
        id !== state.request?.id ||
        typeof approve !== 'boolean' ||
        !note.trim() ||
        note.length > 8192 ||
        (approve && !state.supportedPolicies.includes(state.request.policy))
      )
        return Promise.resolve();
      const facet = selected;
      return mutate(() =>
        E(facet).resolveNetworkPolicyRequest(id, approve, note.trim()),
      );
    },
  });
};
harden(makeFlootNetwork);
