// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';

const policies = harden(['off', 'public-internet']);
const assertPolicy = policy =>
  policies.includes(policy) || Fail`Unknown sandbox network policy`;
const assertNote = note =>
  (typeof note === 'string' && note.trim().length > 0 && note.length <= 8192) ||
  Fail`Provide a nonempty reason of at most 8192 characters`;

/**
 * Factory-owned, single-writer network authorization. Never give the controller
 * to the model: the model receives only request/status tools. An immutable
 * transition intent fences revival before terminating an old generation; an
 * uncertain publication poisons this incarnation instead of reverting policy.
 * @param {{host:any,id:string,supported:()=>Promise<string[]>,prepare:()=>Promise<void>,change:()=>Promise<void>}} options
 */
export const makeSessionNetworkPolicy = ({
  host,
  id,
  supported,
  prepare,
  change,
}) => {
  /^[A-Za-z0-9_-]{1,128}$/.test(id) || Fail`Invalid session identity`;
  const prefix = `floot-network-${id.length}-${id}-`;
  /** @type {any} */
  let state = { policy: 'off', revision: '0' };
  let sequence = 0n;
  let loaded = false;
  let poisoned = false;
  let queue = Promise.resolve();
  const load = async () => {
    if (loaded) return;
    const allNames = await E(host).list();
    Array.isArray(allNames) ||
      Fail`Network policy storage returned invalid names`;
    /** @type {string[]} */
    const names = allNames
      .filter(name => typeof name === 'string' && name.startsWith(prefix))
      .sort();
    names.length <= 4096 || Fail`Network policy audit capacity exhausted`;
    for (const name of names) {
      sequence += 1n;
      name === `${prefix}${`${sequence}`.padStart(20, '0')}` ||
        Fail`Network policy audit sequence is corrupt`;
      // eslint-disable-next-line no-await-in-loop
      const value = await E(host).lookup(name);
      (value?.version === 1 && value.revision === `${sequence}`) ||
        Fail`Network policy audit is corrupt`;
      assertPolicy(value.policy);
      if (value.request) {
        assertPolicy(value.request.policy);
        assertNote(value.request.reason);
        typeof value.request.id === 'string' ||
          Fail`Invalid network request identity`;
      }
      if (value.transition) assertPolicy(value.transition.policy);
      state = value;
    }
    loaded = true;
  };
  const ordered = operation => {
    const result = queue.then(async () => {
      !poisoned ||
        Fail`Network policy storage is uncertain; revive before retrying`;
      try {
        await load();
      } catch (error) {
        poisoned = true;
        throw error;
      }
      return operation();
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const write = async value => {
    sequence < 4096n || Fail`Network policy audit capacity exhausted`;
    const next = sequence + 1n;
    // Preserve space for completing this transition and a later revocation.
    const reserve = value.transition
      ? value.transition.policy === 'public-internet'
        ? 3n
        : 1n
      : value.policy === 'public-internet'
        ? 2n
        : 0n;
    next + reserve <= 4096n ||
      Fail`Network policy audit reserves capacity for revocation`;
    const record = harden({ ...value, version: 1, revision: `${next}` });
    try {
      await E(host).storeValue(
        record,
        `${prefix}${`${next}`.padStart(20, '0')}`,
      );
    } catch (error) {
      poisoned = true;
      throw error;
    }
    state = record;
    sequence = next;
  };
  const supportedPolicies = async () => {
    const values = await supported();
    return harden(policies.filter(policy => values.includes(policy)));
  };
  const requireSupported = async policy => {
    assertPolicy(policy);
    (await supportedPolicies()).includes(policy) ||
      Fail`Backend does not enforce this sandbox network policy`;
  };
  const project = async () => {
    const available = await supportedPolicies();
    return harden({
      policy:
        !state.transition && available.includes(state.policy)
          ? state.policy
          : null,
      supportedPolicies: available,
      applies: 'next-turn',
      ...(state.request ? { request: state.request } : {}),
      ...(state.transition
        ? {
            pendingPolicy: state.transition.policy,
            error:
              'Network policy change is incomplete. Retry applying the pending policy; turns remain blocked.',
          }
        : {}),
    });
  };
  const apply = async (policy, note) => {
    await requireSupported(policy);
    assertNote(note);
    if (state.transition) {
      state.transition.policy === policy ||
        Fail`Retry the pending network policy change first`;
    } else {
      // Reserve space for the commit before admitting an intent.
      sequence <= (policy === 'public-internet' ? 4092n : 4094n) ||
        Fail`Network policy audit capacity exhausted`;
    }
    await prepare();
    if (!state.transition) {
      await write({
        ...state,
        transition: { policy, note },
        action: 'change-intent',
      });
    }
    await change();
    await write({ policy, action: 'change-completed', note });
    return project();
  };
  return harden({
    get: () => ordered(project),
    forTurn: () =>
      ordered(async () => {
        !state.transition || Fail`Network policy change is incomplete`;
        const available = await supportedPolicies();
        if (available.length === 0) {
          sequence === 0n ||
            Fail`Configured sandbox network enforcement is unavailable`;
          return undefined;
        }
        available.includes(state.policy) ||
          Fail`Configured sandbox network enforcement is unavailable`;
        return state.policy;
      }),
    request: (policy, reason) =>
      ordered(async () => {
        await requireSupported(policy);
        assertNote(reason);
        !state.transition || Fail`Network policy change is incomplete`;
        if (state.request) {
          (state.request.policy === policy &&
            state.request.reason === reason) ||
            Fail`A network policy request is already pending`;
          return state.request;
        }
        policy !== state.policy ||
          Fail`Requested network policy is already configured`;
        const request = harden({ id: `${sequence + 1n}`, policy, reason });
        await write({ ...state, request, action: 'requested' });
        return request;
      }),
    set: policy =>
      ordered(() => apply(policy, 'Explicit operator policy selection')),
    resolve: (requestId, approve, note) =>
      ordered(async () => {
        (typeof approve === 'boolean' && state.request?.id === requestId) ||
          Fail`Network request is stale or invalid`;
        assertNote(note);
        if (approve) return apply(state.request.policy, note);
        !state.transition ||
          Fail`Retry the pending network policy change first`;
        await write({
          policy: state.policy,
          action: 'request-denied',
          requestId,
          note,
        });
        return project();
      }),
  });
};
harden(makeSessionNetworkPolicy);
