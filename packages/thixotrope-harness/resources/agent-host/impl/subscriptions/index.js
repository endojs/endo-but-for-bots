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
 *   read parses the stored credential without renewing (section 7).
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

import { poolKinds } from '../../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../../../config/subscription-defaults.js';
import { providerBaseUrl } from '../providers/http.js';
import { makeAccounts, makeUsageReader } from './accounts.js';
import { makePoolCatalog } from './catalog.js';
import { makeCredentialOps, makeSecretResolver } from './credential-ops.js';
import { parseCredential } from './credentials.js';
import { makePoolCore } from './pool.js';
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
 * One pool as this incarnation knows it.
 * @typedef {object} PoolRecord
 * @property {any} backend
 * @property {any} spec the `PoolSpec` the manager forwarded
 * @property {PoolStateBridge & { pending: () => number }} bridge
 * @property {any} [loaded] the last `PoolState` loaded
 * @property {'active' | 'retired'} state
 * @property {readonly MemberEntry[]} members in declaration order
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
  /** @type {WeakMap<any, ReturnType<typeof makeMemberCredential>>} */
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
   */
  const credentialOf = (entry, spec = specOfMember.get(entry.member) ?? {}) => {
    const known = memberCredentials.get(entry.member);
    if (known !== undefined) return known;
    const endpoint = endpoints[entry.provider];
    const made = makeMemberCredential({
      access: accessOf(entry),
      provider: entry.provider,
      tokenUrl: spec.tokenUrl ?? endpoint.tokenUrl,
      clientId: endpoint.clientId,
      ...fetchOption,
      now,
      settings: { refreshSkewMs: settings.refreshSkewMs },
    });
    memberCredentials.set(entry.member, made);
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
    if (pool.loaded !== loaded) {
      const unchanged =
        pool.loaded !== undefined &&
        pool.state === loaded.state &&
        sameMembers(pool.members, loaded.members);
      pool.loaded = loaded;
      pool.state = loaded.state;
      pool.members = loaded.members;
      for (const entry of loaded.members)
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
          members: loaded.members,
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
    // Section 7: an account read never renews; it reads what is stored.
    credential: async member => {
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
      usage: async (backend, entry) => {
        await ensureUsageSpec(backend);
        const reading = await usageReader(backend, entry);
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
        return harden({
          kind: info.kind,
          label: info.label,
          members: state.members,
        });
      },
    },
    ...(onError === undefined ? {} : { onError }),
  });

  const poolCatalog = makePoolCatalog({
    ...fetchOption,
    now,
    readCredential: async entry =>
      (await credentialOf(entry).current()).credential,
    members: async (backend, spec) => [
      ...(await loadPool(backend, spec)).members,
    ],
  });

  const credentialOps = makeCredentialOps({
    secrets,
    accounts: () => accounts.accounts,
    resolveSecret,
    // 3.1 (XB): a retirement in the manager; each loaded pool asks
    // `poolState` again at its next use (one manager crank per used pool).
    poolsChanged: () => {
      for (const pool of pools.values()) pool.bridge.invalidate();
    },
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
