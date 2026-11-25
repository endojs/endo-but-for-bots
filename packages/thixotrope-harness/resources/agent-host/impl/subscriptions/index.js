// @ts-check
/**
 * One adapter incarnation's subscriptions (M4 W4.6; `designs/m4-interfaces.md`
 * 3.2, 5, 6, 7, 10; `types.js` `Subscriptions`): the composition of W4.2's
 * pool core and manager bridge, W4.3's catalogue, W4.4's credentials and
 * W4.5's accounts, keyed by objects (rule 2): pools by their `Backend`
 * presence, members by their `PoolMember` presence, sessions by their
 * `Session` presence.
 *
 * Made once per incarnation by `AH/index.js` (H-4 c) and touched lazily:
 * nothing reads a file, the Secrets store or the manager until a pool is
 * used (D-5: dormant after a restart).
 *
 * - **Pools** load once per incarnation (`E(sink).poolState(backend)`, one
 *   manager crank) at their first round, catalogue read or accounts use.
 *   The load builds the pool core (`pool.js`) from the manager's marks and
 *   last-served records and registers the pool with the accounts oracle.
 *   Mark changes and served stamps go back through the bridge
 *   (`pool-state.js`): marks at once, stamps coalesced.
 * - **Readings** (every attempt's rate-limit headers, and on-demand usage
 *   reads) feed the core's selection (`readingOf`, and `observed` so a newer
 *   open reading lifts a dated mark) and the accounts oracle.
 * - **Credentials**: one `MemberCredential` (`renewal.js`) per member and
 *   incarnation, holding `secrets().credentialFor(key)` only (W-5). A usage
 *   read for a model uses the stored credential; an operator refresh may
 *   renew it through the same broker as inference.
 * - **Catalogue**: the pool catalogue (`catalog.js`) over the same members
 *   and credentials.
 * - `credentialOps`: the `CredentialOps` facet (`ops.credentials()`, H-3).
 *
 * Providers' endpoints: the refresh token endpoints, public OAuth client ids
 * and usage URLs are the reference modules' (claude-sandbox and
 * codex-sandbox `subscription-auth.js`, codex-sandbox
 * `codex-account-read.js`, 1315bef86). A pool spec's `tokenUrl` and
 * `usageUrl` replace them (tests point them at the fake servers).
 *
 * Node only (adapter).
 */
import { join } from 'node:path';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import {
  poolKinds,
  providerOfKind,
  subscriptionTexts,
} from '../../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../../../config/subscription-defaults.js';
import { providerBaseUrl } from '../providers/http.js';
import { makeAccounts, makeUsageReader } from './accounts.js';
import { makePoolCatalog } from './catalog.js';
import { makeCredentialOps, makeSecretResolver } from './credential-ops.js';
import { parseCredential } from './credentials.js';
import { makePoolCore } from './pool.js';
import { makePoolAdditions } from './pool-additions.js';
import { initialFromPoolState, makePoolStateBridge } from './pool-state.js';
import { makeMemberCredential } from './renewal.js';

/** @import { MemberEntry, Reading, PoolStateBridge } from './types.js' */

/**
 * The providers' public endpoints (reference modules, 1315bef86).
 * @type {Readonly<Record<'claude' | 'codex', { tokenUrl: string, clientId: string, usageUrl: string }>>}
 */
export const providerEndpoints = harden({
  claude: {
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    usageUrl: 'https://api.anthropic.com/api/oauth/usage',
  },
  codex: {
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
  },
});

/**
 * Adapter-kept additions waiting for an operator (before the gateway's
 * first bind) are looked for again at a pool's next load after this long.
 */
const ADDITIONS_RETRY_MS = 5000;

/**
 * One pool as this incarnation knows it.
 * @typedef {object} PoolRecord
 * @property {any} backend
 * @property {any} spec the `PoolSpec` the manager forwarded
 * @property {PoolStateBridge & { pending: () => number }} bridge
 * @property {any} [loaded] the last `PoolState` loaded
 * @property {'active' | 'retired'} state
 * @property {readonly MemberEntry[]} members in declaration order, then
 *   the adapter-kept additions (`pool-additions.js`)
 * @property {number} [additionsRev] the additions' `rev` they were read at
 * @property {boolean} [additionsPending] some wait for an operator
 * @property {number} [additionsAskedAt] when they were last looked for
 * @property {ReturnType<typeof makePoolCore> | undefined} core
 */

/**
 * @template T
 * @param {T | (() => T)} value
 * @returns {T}
 */
const lazy = value =>
  typeof value === 'function' ? /** @type {() => T} */ (value)() : value;

/**
 * @param {object} options
 * @param {any} options.sink the `AgentHostSink`, or a function answering
 *   the current one (`undefined` while unattached)
 * @param {any} options.secrets the Secrets operations, or a function
 *   answering them (`AH/index.js`'s `secrets` helper: `credentialFor`,
 *   `store`, optionally `resolveSecret`)
 * @param {() => string} options.stateDir the daemon's state directory
 * @param {import('../timers.js').Timers} options.timers
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {typeof subscriptionDefaults} [options.settings] tests scale the
 *   overload delays here
 * @param {typeof providerEndpoints} [options.endpoints]
 * @param {(error: unknown) => void} [options.onError] a failed readings
 *   file write
 * @param {() => any} [options.currentOperator] the `Operator` the gateway serves
 *   now (undefined before its first bind): how adapter-kept pool
 *   additions reach the manager's `SecretsAdmin` and `SubscriptionsAdmin`
 */
export const makeSubscriptions = ({
  sink,
  secrets,
  stateDir,
  timers,
  fetch,
  now = () => Date.now(),
  settings = subscriptionDefaults,
  endpoints = providerEndpoints,
  onError,
  currentOperator = () => undefined,
}) => {
  const sinkNow = () => lazy(sink);
  const fetchOption = fetch === undefined ? {} : { fetch };

  /**
   * Pools seen in this incarnation (bounded by the pools the manager made:
   * `maxPools` active plus those retired while this adapter ran).
   * @type {Map<any, PoolRecord>}
   */
  const pools = new Map();
  /** @type {WeakMap<object, Promise<void>>} */
  const specLoads = new WeakMap();

  /**
   * The pinned manager forwards its private spec with catalogue calls.
   * Ask for zero rows to hydrate the endpoint without reading models or
   * renewing credentials. Concurrent cold refreshes share the round trip.
   * @param {any} backend
   */
  const ensureUsageSpec = async backend => {
    if (pools.has(backend)) return;
    let flight = specLoads.get(backend);
    if (!flight) {
      flight = Promise.resolve(E(backend).listModels(harden({ limit: 0 })))
        .then(() => undefined)
        .finally(() => specLoads.delete(backend));
      specLoads.set(backend, flight);
    }
    await flight;
  };
  /** @type {WeakMap<any, { tokenUrl: string, holder: ReturnType<typeof makeMemberCredential> }>} */
  const memberCredentials = new WeakMap();
  /** The spec of the first pool a member was loaded in (its `tokenUrl`). */
  /** @type {WeakMap<any, any>} */
  const specOfMember = new WeakMap();
  /** Backends that answered a non-pool kind (asked once per incarnation). */
  /** @type {WeakSet<any>} */
  const notPools = new WeakSet();
  /** The latest reading of each member (selection's `readingOf`). */
  /** @type {WeakMap<any, Reading>} */
  const readings = new WeakMap();

  /** @param {MemberEntry} entry */
  const accessOf = entry => lazy(secrets).credentialFor(entry.key);

  /**
   * The member's renewing credential, one per member and incarnation.
   * @param {MemberEntry} entry
   * @param {any} [spec]
   * @param {boolean} [requirePoolEndpoint] operator usage must renew only
   * at the endpoint of the pool it is reading
   */
  const credentialOf = (
    entry,
    spec = specOfMember.get(entry.member) ?? {},
    requirePoolEndpoint = false,
  ) => {
    const known = memberCredentials.get(entry.member);
    const endpoint = endpoints[entry.provider];
    const tokenUrl = spec.tokenUrl ?? endpoint.tokenUrl;
    if (requirePoolEndpoint) {
      const prior = specOfMember.get(entry.member);
      const ownerUrl =
        known?.tokenUrl ??
        (prior ? (prior.tokenUrl ?? endpoint.tokenUrl) : tokenUrl);
      if (ownerUrl !== tokenUrl)
        throw Error('Conflicting token endpoints for the same pool member');
    }
    if (known !== undefined) return known.holder;
    const made = makeMemberCredential({
      access: accessOf(entry),
      provider: entry.provider,
      tokenUrl,
      clientId: endpoint.clientId,
      ...fetchOption,
      now,
      settings: { refreshSkewMs: settings.refreshSkewMs },
    });
    memberCredentials.set(entry.member, { tokenUrl, holder: made });
    return made;
  };

  const ownResolver = makeSecretResolver(sinkNow);
  /** @param {any} secret */
  const resolveSecret = secret => {
    const ops = lazy(secrets);
    return typeof ops?.resolveSecret === 'function'
      ? ops.resolveSecret(secret)
      : ownResolver(secret);
  };

  /**
   * @param {any} backend
   * @param {any} spec
   * @returns {PoolRecord}
   */
  const recordOf = (backend, spec) => {
    const known = pools.get(backend);
    if (known !== undefined) return known;
    /** @type {PoolRecord} */
    const made = {
      backend,
      spec,
      bridge: makePoolStateBridge({
        sink: sinkNow,
        backend,
        timers,
        now,
        settings: {
          servedFlushMs: settings.servedFlushMs,
          stateRefreshMs: settings.poolStateRefreshMs,
        },
      }),
      loaded: undefined,
      state: 'active',
      members: [],
      core: undefined,
    };
    pools.set(backend, made);
    return made;
  };

  /**
   * The manager's admin objects through the operator the gateway serves
   * (undefined while it has none), asked at each use.
   */
  const admins = async () => {
    const current = currentOperator();
    if (current === undefined) return undefined;
    const secretsAdmin = await E(current).getSecrets();
    const subscriptionsAdmin = await E(secretsAdmin).subscriptions();
    return harden({ secrets: secretsAdmin, subscriptions: subscriptionsAdmin });
  };

  const additions = makePoolAdditions({
    file: () =>
      join(stateDir(), 'agent-host', 'subscriptions', 'pool-additions.json'),
    admins,
    resolveSecret,
    checkCredential: (secret, provider) =>
      credentialOps.checkCredential(secret, provider),
    livePools: async () => {
      const reached = await admins();
      const target = sinkNow();
      if (reached === undefined || target === undefined) return [];
      const { pools: listed } = await E(reached.subscriptions).listPools();
      return Promise.all(
        listed.map(async (/** @type {any} */ backend) => {
          const [info, state] = await Promise.all([
            E(backend).describe(),
            E(target).poolState(backend),
          ]);
          return harden({
            kind: info.kind,
            label: info.label,
            specKeys: state.members.map((/** @type {any} */ m) => m.key),
          });
        }),
      );
    },
    ...(onError === undefined ? {} : { onError }),
  });

  /**
   * A pool's adapter-kept additions over its manager state; a failure
   * serves the spec members alone (and looks again at the next load).
   * @param {{ kind: string, label: string }} info
   * @param {any} state a `PoolState`
   * @returns {Promise<{ members: MemberEntry[], pending: boolean }>}
   */
  const withAdditions = async (info, state) => {
    if (state.state === 'retired') return { members: [], pending: false };
    try {
      return await additions.extrasOf(info, state.members);
    } catch (error) {
      onError?.(error);
      return { members: [], pending: true };
    }
  };

  /** @type {ReturnType<typeof makeAccounts>} */
  let accounts;

  /**
   * Mirror the core's mark changes into the accounts view.
   * @param {PoolRecord} pool
   * @param {import('./types.js').PoolChange} change
   */
  const mirror = (pool, change) => {
    for (const { member, mark } of change.marks ?? []) {
      const entry = pool.members.find(candidate => candidate.member === member);
      if (entry !== undefined) {
        if (mark === undefined) accounts.memberState(pool.backend, entry, 'ok');
        else
          accounts.memberState(
            pool.backend,
            entry,
            'marked',
            undefined,
            mark.untilMs,
          );
      }
    }
  };

  /**
   * Whether two loads name the same members in the same states.
   * @param {readonly MemberEntry[]} before
   * @param {readonly MemberEntry[]} after
   */
  const sameMembers = (before, after) =>
    before.length === after.length &&
    before.every(
      (entry, index) =>
        entry.member === after[index].member &&
        entry.state === after[index].state,
    );

  /**
   * The pool, loaded: its members, state and core (one `poolState` per
   * incarnation, asked again after the manager's `poolsChanged` push so a
   * retirement reaches the next round (XB), and when older than
   * `poolStateRefreshMs` as a safety net; a failed load is asked again
   * next time).
   * @param {any} backend
   * @param {any} spec
   */
  const loadPool = async (backend, spec) => {
    const pool = recordOf(backend, spec);
    const loaded = await pool.bridge.load();
    if (
      pool.loaded !== loaded ||
      pool.additionsRev !== additions.rev() ||
      (pool.additionsPending === true &&
        now() - (pool.additionsAskedAt ?? 0) >= ADDITIONS_RETRY_MS)
    ) {
      const rev = additions.rev();
      const extras = await withAdditions(spec, loaded);
      const members = harden([...loaded.members, ...extras.members]);
      const unchanged =
        pool.loaded !== undefined &&
        pool.state === loaded.state &&
        sameMembers(pool.members, members);
      pool.loaded = loaded;
      pool.state = loaded.state;
      pool.members = members;
      pool.additionsRev = rev;
      pool.additionsPending = extras.pending;
      pool.additionsAskedAt = now();
      if (loaded.state === 'retired')
        additions.poolRetired(pool.spec, loaded.members);
      for (const entry of members)
        if (!specOfMember.has(entry.member))
          specOfMember.set(entry.member, pool.spec);
      if (pool.core === undefined) {
        pool.core = makePoolCore({
          members: () => pool.members,
          readingOf: member => readings.get(member),
          cacheLifetimeMs:
            pool.spec.cacheLifetimeMs ?? settings.cacheLifetimeMs,
          now,
          initial: initialFromPoolState(loaded),
          onChange: change => {
            pool.bridge.record(change);
            mirror(pool, change);
          },
          settings,
        });
      }
      if (!unchanged)
        accounts.register(backend, {
          kind: pool.spec.kind,
          label: pool.spec.label,
          members,
        });
    }
    return pool;
  };

  /**
   * A new reading of a member: selection, a dated mark it may lift, the
   * accounts view.
   * @param {any} backend
   * @param {MemberEntry} entry
   * @param {Reading} reading
   */
  const observe = (backend, entry, reading) => {
    const previous = readings.get(entry.member);
    if (previous === undefined || previous.at <= reading.at)
      readings.set(entry.member, reading);
    pools.get(backend)?.core?.observed(entry.member, reading);
    accounts.observe(backend, entry, reading);
  };

  const usageReader = makeUsageReader({
    // Only a pool whose spec this incarnation holds is read: a pool the
    // accounts view described without its spec (after a restart, before its
    // first open or catalogue read) may name its own `usageUrl`, and the
    // provider's default must not be read in its place (W4.8). Its readings
    // stay `remembered` until the genuine pool spec is available.
    url: (backend, member) => {
      const pool = pools.get(backend);
      if (pool === undefined) return undefined;
      const url = pool.spec.usageUrl ?? endpoints[member.provider]?.usageUrl;
      if (url === undefined) return undefined;
      // INT-M4: the M2 review's base URL rule (https, or http to loopback);
      // a refused usage URL is not read, as a pool with no URL.
      try {
        return providerBaseUrl(url, url);
      } catch {
        return undefined;
      }
    },
    credential: async (member, backend, operator) => {
      if (operator) {
        const pool = pools.get(backend);
        if (!pool) throw Error('Pool specification unavailable');
        return (await credentialOf(member, pool.spec, true).current())
          .credential;
      }
      // Model-initiated usage reads may only use the stored access token.
      const { value } = await accessOf(member).read();
      return parseCredential(value, member.provider);
    },
    ...fetchOption,
    now,
  });

  accounts = makeAccounts({
    file: () =>
      join(stateDir(), 'agent-host', 'subscriptions', 'readings.json'),
    timers,
    now,
    readers: {
      usage: async (backend, entry, operator) => {
        await ensureUsageSpec(backend);
        const reading = await usageReader(backend, entry, operator);
        if (reading !== undefined) {
          const previous = readings.get(entry.member);
          if (previous === undefined || previous.at <= reading.at)
            readings.set(entry.member, reading);
          pools.get(backend)?.core?.observed(entry.member, reading);
        }
        return reading;
      },
      poolOf: async session => {
        const target = sinkNow();
        if (target === undefined) return undefined;
        return E(target).poolOf(session);
      },
      // A backend this incarnation has not used yet (after a restart: D-5,
      // pools load lazily) is asked what it is: `describe()` (one manager
      // crank) and, for a pool kind, its members from `poolState` (one
      // more), so the accounts view shows remembered readings before the
      // pool's first round (acceptance 7). It is not registered as a pool
      // record here (its spec, with any test endpoints, arrives with its
      // first open or catalogue read). Anything else (API backends'
      // accountStatus asks too) is not a pool: undefined, never a throw.
      describe: async backend => {
        const pool = pools.get(backend);
        if (pool !== undefined) {
          const loaded = await loadPool(backend, pool.spec);
          return harden({
            kind: loaded.spec.kind,
            label: loaded.spec.label,
            members: loaded.members,
          });
        }
        const target = sinkNow();
        if (target === undefined || notPools.has(backend)) return undefined;
        const info = await E(backend)
          .describe()
          .catch(() => undefined);
        if (info === undefined || !poolKinds.includes(info.kind)) {
          notPools.add(backend);
          return undefined;
        }
        const state = await E(target).poolState(backend);
        const extras = await withAdditions(info, state);
        return harden({
          kind: info.kind,
          label: info.label,
          members: [...state.members, ...extras.members],
        });
      },
    },
    methods: {
      addMember: (backend, request) => addMember(backend, request),
      /**
       * The format check of a Secret for a pool's provider (the value
       * stays here): ok or a code.
       * @param {any} backend
       * @param {any} secret
       */
      checkCredential: async (backend, secret) => {
        const { provider } = await poolFacts(backend);
        return credentialOps.checkCredential(secret, provider);
      },
      /**
       * The active members a pool serves (its spec's and the additions),
       * so the page can tell an interrupted add from a member in a pool.
       * @param {any} backend
       */
      poolMembers: async backend => {
        const { info, state } = await poolFacts(backend);
        const extras = await withAdditions(info, state);
        return harden(
          [...state.members, ...extras.members]
            .filter(entry => entry.state === 'active')
            .map(entry => entry.member),
        );
      },
    },
    ...(onError === undefined ? {} : { onError }),
  });

  /**
   * A pool backend's `describe()` and current `PoolState` (two manager
   * cranks), refused when it is not an active pool.
   * @param {any} backend
   */
  const poolFacts = async backend => {
    const target = sinkNow();
    if (target === undefined) throw Error('the agent host is not attached');
    const info = await E(backend).describe();
    const provider = providerOfKind[info.kind];
    if (provider === undefined) throw Error(subscriptionTexts.memberKind);
    const state = await E(target).poolState(backend);
    if (state.state === 'retired') throw Error(subscriptionTexts.retired);
    return { info, provider, state };
  };

  /**
   * `Accounts.addMember`: the manager's own `addMember` when it has one
   * (introspected each time: a state provisioned later has it); else an
   * adapter-kept addition (`pool-additions.js`). Either way the pool's
   * loads see the member next, and the accounts view reads the pool again.
   * @param {any} backend
   * @param {{ label: string, credential: any, weight?: number, declared?: any }} request
   */
  const addMember = async (backend, request) => {
    const reached = await admins();
    if (reached !== undefined) {
      // eslint-disable-next-line no-underscore-dangle -- the Endo introspection method
      const names = await E(reached.subscriptions).__getMethodNames__();
      if (names.includes('addMember'))
        return E(reached.subscriptions).addMember(backend, request);
    }
    const { info, state } = await poolFacts(backend);
    const member = await additions.add(info, state.members, request);
    accounts.poolsChanged();
    return member;
  };

  const poolCatalog = makePoolCatalog({
    ...fetchOption,
    now,
    readCredential: async entry =>
      (await credentialOf(entry).current()).credential,
    members: async (backend, spec) => [
      ...(await loadPool(backend, spec)).members,
    ],
    // Each member's last good list survives a restart (the member reads
    // file); each read's outcome (a code at most) shows on its account.
    remembered: entry => accounts.rememberedModels(entry),
    onMemberRead: (entry, outcome) => accounts.catalogRead(entry, outcome),
  });

  const credentialOps = makeCredentialOps({
    secrets,
    accounts: () => accounts.accounts,
    resolveSecret,
    // 3.1 (XB): a retirement or a member added in the manager; each loaded
    // pool asks `poolState` again at its next use (one manager crank per
    // used pool), and the accounts view asks again at its next read of a
    // pool, so an added member shows without waiting for a round.
    poolsChanged: () => {
      for (const pool of pools.values()) pool.bridge.invalidate();
      accounts.poolsChanged();
    },
    now,
  });

  return harden({
    catalog: harden({
      /** @param {any} request M2 `makeCatalog`'s request (`backend`, `spec`, ...) */
      listModels: async request => {
        recordOf(request.backend, request.spec);
        if (request.request?.limit === 0 && specLoads.has(request.backend))
          return harden({ rows: [], state: 'ok' });
        return poolCatalog.listModels(request);
      },
      /** @param {any} request */
      resolveModel: request => {
        recordOf(request.backend, request.spec);
        return poolCatalog.resolveModel(request);
      },
      /** @param {any} member */
      stats: member => poolCatalog.stats(member),
    }),
    credentialOps,
    accounts,
    /** The adapter-kept pool additions (`pool-additions.js`; tests). */
    additions,
    /**
     * The pool's manager bridge, loaded (`types.js` `Subscriptions.poolOf`).
     * @param {any} backend
     * @param {any} spec
     */
    poolOf: async (backend, spec) => (await loadPool(backend, spec)).bridge,
    // ---- for the pool provider (`provider.js`) and tests ----
    /**
     * The loaded pool record of a backend (its core, members and state).
     * @param {any} backend
     * @param {any} spec
     */
    pool: loadPool,
    /**
     * Know a pool backend and its spec without loading it (the provider is
     * made at the pool's first `open`), so `Accounts.forBackend` can load it
     * on demand.
     * @param {any} backend
     * @param {any} spec
     */
    know: (backend, spec) => {
      recordOf(backend, spec);
    },
    observe,
    credentialOf,
    settings,
    ...fetchOption,
    /** Send every waiting served stamp now (tests, shutdown). */
    flush: async () => {
      await Promise.all([...pools.values()].map(pool => pool.bridge.flush()));
      await accounts.flush();
    },
    close: () => accounts.close(),
  });
};
harden(makeSubscriptions);
