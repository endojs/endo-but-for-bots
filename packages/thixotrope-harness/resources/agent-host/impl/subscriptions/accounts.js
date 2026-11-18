// @ts-check
/**
 * Accounts (W4.5; `designs/m4-interfaces.md` section 6): the account oracle
 * of every subscription pool, adapter-side only. Port of hosted-agent
 * `account-oracle.js` and `account.js` (normalisation, provenance) and of
 * the usage reads of claude-sandbox and codex-sandbox `subscription-auth.js`
 * / `codex-account-read.js`, with object keys: pools by their `Backend`
 * presence, members by their `PoolMember` presence, sessions by their
 * `Session` presence.
 *
 * - **Sources** (R4-84): `observed` = a reading of this incarnation (the
 *   rate-limit headers of every attempt through `observe`, or an on-demand
 *   usage read through `refresh`); `remembered` = a reading from the
 *   readings file (an earlier incarnation's) or this incarnation's after a
 *   failed refresh; `declared` = the member's `DeclaredProfile`;
 *   `unavailable` = none.
 * - **Push, never poll** (R4-85): every new reading, member state change or
 *   pool registration publishes one `AccountsBatch` (the whole view, `rev`
 *   + 1) to the subscribers of `Accounts.watch`. Zero vat deliveries per
 *   change and per viewer: the view is built here, once per `rev`, and only
 *   when someone reads it. Nothing is queued per subscriber: a subscriber is
 *   always answered the newest view, so a slow page costs nothing.
 * - **Keepalive and idle eviction** (section 6, M3 4.5): a `next()` that has
 *   waited `accountsKeepaliveMs` (30 s) with no change is answered the
 *   current view again (same `rev`); a subscriber with no `next()` call for
 *   `accountsIdleMs` (60 s) and none waiting is idle and is evicted (its
 *   next `next()` rejects with `m4Texts.accountsWatchClosed`). Eviction is
 *   swept at each `watch`, publish and `next()`, so no per-subscriber idle
 *   timer runs; only a waiting `next()` holds a timer. A `watch` that meets
 *   the cap (`channelLimits.subscribersPerSession`, 32) after the sweep is
 *   refused: every subscriber left has called within 60 s or is waiting.
 * - **Refresh on demand only** (R4-85): `refresh(pool?)` reads the
 *   providers now; nothing reads a provider on a first `list`,
 *   `forBackend`, `forSession` or `watch`. A renewal never runs on an
 *   account read (m4-interfaces 7): the usage reader is given the
 *   credential as it stands. Each member is read by one flight at a time
 *   (concurrent refreshes share it), and the model's refresh
 *   (`accountStatus { refresh: true }`, `refreshForModel`) reads a member
 *   at most once per `modelRefreshMs` (60 s), counting reads by any path,
 *   so a looping model cannot hammer the providers' usage endpoints.
 * - **Readings file** (`account-file.js`): loaded lazily at the first use
 *   in an incarnation; written at most every `readingsFlushMs`.
 *
 * Nothing here holds or logs a credential: the usage reader receives the
 * access token from its caller per read and puts only status codes in its
 * errors.
 *
 * Node only (reads the guest prelude for `makeExo`, `makePromiseKit`).
 */
import { Buffer } from 'node:buffer';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  m4Interfaces,
  m4Limits,
  m4Texts,
} from '../../../../guest/lib/interfaces-m4.js';
import { limits } from '../../../../guest/lib/limits.js';
import { boundToolOutput } from '../../../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import { channelLimits } from '../../../../config/defaults.js';
import {
  checkReading,
  loadReadings,
  makeReadingsWriter,
} from './account-file.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { MemberEntry, Reading, ReadingWindow, AccountsCore } from './types.js' */
/** @import { ReadingsEntry } from './account-file.js' */

const { makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The refusal of a `watch` at the subscriber cap when no subscriber is idle
 * (harness text; `texts-m4.js` has none for it, reported to the PM).
 */
export const accountsWatchLimitText =
  'Too many live accounts watchers; close one and watch again';

/**
 * Fae `session-account.js` `costUnavailable` (word for word): no cost, no
 * attribution of usage to an account.
 */
export const usageNotAttributedText =
  'Session usage is not attributed to individual accounts. Published mappings do not establish runtime eligibility, the current route, or the payer of previous turns.';

/** Node's `Date` range (ms). */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * An ISO 8601 time, or undefined for a value that is not a time.
 * @param {number | undefined} ms
 */
export const isoOf = ms =>
  typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= MAX_DATE_MS
    ? new Date(ms).toISOString()
    : undefined;
harden(isoOf);

/**
 * @typedef {object} PoolInfo
 * @property {'claude-pool' | 'codex-pool'} kind
 * @property {string} label
 * @property {readonly MemberEntry[]} members
 */

/**
 * @typedef {object} AccountReaders
 * @property {(backend: any, member: MemberEntry) => Promise<Reading | undefined>} [usage]
 *   one on-demand usage read of a member (W4.6 builds it with
 *   `makeUsageReader` and the member's credential); called by `refresh` only
 * @property {(session: any) => Promise<any>} [poolOf] the session's pool
 *   when this incarnation did not see it open one: one `E(sink).poolOf`
 * @property {(backend: any) => Promise<PoolInfo | undefined>} [describe]
 *   a pool this incarnation has not registered yet (one `poolState` load
 *   and one `describe`); undefined for a backend that is not a pool
 */

/**
 * @typedef {object} AccountsSettings
 * @property {number} [keepaliveMs] default `m4Limits.accountsKeepaliveMs`
 * @property {number} [idleMs] default `m4Limits.accountsIdleMs`
 * @property {number} [subscribers] default `channelLimits.subscribersPerSession`
 * @property {number} [readingsFlushMs] default 5,000
 * @property {number} [modelRefreshMs] the model's refresh reads a member at
 *   most this often (default 60,000)
 */

/**
 * @typedef {AccountsCore & {
 *   register: (backend: any, info: PoolInfo) => void,
 *   refreshForModel: (backend: any) => Promise<void>,
 *   rev: () => number,
 *   subscriberCount: () => number,
 *   close: () => Promise<void>,
 * }} AccountsCoreM4
 *   `register` is how W4.6 tells the oracle a pool's kind, label and
 *   members (at its `poolState` load and after a member change); the rest
 *   are for tests, perf and shutdown.
 */

/**
 * A window as a person or the model sees it (the `Window` shape).
 * @param {ReadingWindow} window
 */
const viewWindow = window =>
  harden({
    name: window.name,
    usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
    ...(isoOf(window.resetsAtMs) === undefined
      ? {}
      : { resetsAt: isoOf(window.resetsAtMs) }),
    ...(window.windowMinutes === undefined
      ? {}
      : { windowMinutes: window.windowMinutes }),
  });

/**
 * A declared window (already in the `Window` shape), bounded.
 * @param {any} window
 */
const declaredWindow = window =>
  harden({
    name: window.name,
    usedPercent: Math.min(100, Math.max(0, Number(window.usedPercent) || 0)),
    ...(typeof window.resetsAt === 'string'
      ? { resetsAt: window.resetsAt.slice(0, m4Limits.timeUnits) }
      : {}),
    ...(typeof window.windowMinutes === 'number'
      ? { windowMinutes: window.windowMinutes }
      : {}),
  });

/** @param {unknown} text */
const labelText = text => String(text ?? '').slice(0, limits.labelUnits);

/**
 * @param {object} options
 * @param {string | (() => string)} options.file the readings file
 * @param {{ after: (ms: number, fn: () => void) => () => void }} options.timers
 * @param {() => number} [options.now]
 * @param {AccountReaders} [options.readers]
 * @param {AccountsSettings} [options.settings]
 * @param {(error: unknown) => void} [options.onError] a failed file write
 * @returns {AccountsCoreM4}
 */
export const makeAccounts = ({
  file,
  timers,
  now = Date.now,
  readers = {},
  settings = {},
  onError,
}) => {
  const keepaliveMs = settings.keepaliveMs ?? m4Limits.accountsKeepaliveMs;
  const idleMs = settings.idleMs ?? m4Limits.accountsIdleMs;
  const maxSubscribers =
    settings.subscribers ?? channelLimits.subscribersPerSession;
  const modelRefreshMs = settings.modelRefreshMs ?? 60_000;
  const fileOf = typeof file === 'function' ? file : () => file;
  const writer = makeReadingsWriter({
    file: fileOf,
    timers,
    flushMs: settings.readingsFlushMs ?? 5000,
    ...(onError === undefined ? {} : { onError }),
  });

  // Pools in registration order, at most `maxPools`.
  /** @type {Map<any, PoolInfo>} */
  const pools = new Map();
  // This incarnation's readings (observed, or demoted).
  /** @type {Map<any, Reading>} */
  const readingOfMember = new Map();
  // The readings file's mirror, by store key.
  /** @type {Map<string, ReadingsEntry>} */
  const fileEntries = new Map();
  /** @type {Map<any, { state: 'ok' | 'marked' | 'unusable' | 'retired', code?: string, markedUntilMs?: number }>} */
  const stateOfMember = new Map();
  // Sessions that opened a pool in this incarnation.
  /** @type {WeakMap<any, any>} */
  const poolOfSession = new WeakMap();
  let loaded = false;
  let rev = 0;
  /** @type {{ rev: number, view: any } | undefined} */
  let cached;

  const ensureLoaded = () => {
    if (loaded) return;
    loaded = true;
    for (const entry of loadReadings(fileOf())) {
      if (fileEntries.size >= m4Limits.maxMembers) break;
      fileEntries.set(entry.key, entry);
    }
  };

  /**
   * The reading shown for a member: this incarnation's, else the file's
   * (remembered) when it is for the same provider.
   * @param {MemberEntry} entry
   * @returns {Reading | undefined}
   */
  const readingOf = entry => {
    const own = readingOfMember.get(entry.member);
    if (own !== undefined) return own;
    const remembered = fileEntries.get(entry.key);
    if (remembered === undefined || remembered.provider !== entry.provider)
      return undefined;
    return remembered.reading.source === 'remembered'
      ? remembered.reading
      : { ...remembered.reading, source: 'remembered' };
  };

  /** @param {MemberEntry} entry */
  const memberAccount = entry => {
    const known = stateOfMember.get(entry.member);
    const markedUntilMs =
      known?.markedUntilMs ??
      (entry.mark !== undefined && entry.mark.untilMs > now()
        ? entry.mark.untilMs
        : undefined);
    /** @type {'ok' | 'marked' | 'unusable' | 'retired'} */
    let state = 'ok';
    if (entry.state === 'retired') state = 'retired';
    else if (known !== undefined) state = known.state;
    else if (markedUntilMs !== undefined) state = 'marked';
    /** @type {Record<string, any>} */
    const account = {
      label: labelText(entry.label),
      provider: entry.provider,
      state,
    };
    const reading = readingOf(entry);
    if (reading !== undefined) {
      account.provenance = reading.source;
      account.windows = harden(
        reading.windows.slice(0, m4Limits.maxWindows).map(viewWindow),
      );
      account.limitReached = reading.limitReached;
      if (reading.plan !== undefined) account.plan = reading.plan;
      if (reading.credits !== undefined) account.credits = reading.credits;
      if (reading.banked !== undefined)
        account.banked = harden(
          reading.banked.slice(0, m4Limits.maxBankedCredits).map(credit =>
            harden({
              ...(isoOf(credit.expiresAtMs) === undefined
                ? {}
                : { expiresAt: isoOf(credit.expiresAtMs) }),
              ...(credit.label === undefined
                ? {}
                : { label: labelText(credit.label) }),
            }),
          ),
        );
      const at = isoOf(reading.at);
      if (at !== undefined) account.at = at;
    } else if (entry.declared !== undefined) {
      account.provenance = 'declared';
      account.windows = harden(
        (entry.declared.windows ?? [])
          .slice(0, m4Limits.maxWindows)
          .map(declaredWindow),
      );
      account.limitReached = false;
      if (typeof entry.declared.plan === 'string')
        account.plan = entry.declared.plan.slice(0, m4Limits.planUnits);
    } else {
      account.provenance = 'unavailable';
      account.windows = harden([]);
      account.limitReached = false;
    }
    if (state === 'marked' && isoOf(markedUntilMs) !== undefined)
      account.markedUntil = isoOf(markedUntilMs);
    if (known?.code !== undefined)
      account.code = known.code.slice(0, limits.secretCodeUnits);
    return harden(account);
  };

  /**
   * @param {any} backend
   * @param {PoolInfo} info
   */
  const poolAccounts = (backend, info) =>
    harden({
      backend,
      kind: info.kind,
      label: labelText(info.label),
      selection: 'auto',
      members: harden(
        info.members.slice(0, m4Limits.maxPoolMembers).map(memberAccount),
      ),
    });

  /** The whole view at the current `rev`, built once per `rev`. */
  const view = () => {
    ensureLoaded();
    if (cached === undefined || cached.rev !== rev) {
      cached = {
        rev,
        view: harden({
          rev,
          pools: harden(
            [...pools].map(([backend, info]) => poolAccounts(backend, info)),
          ),
        }),
      };
    }
    return cached.view;
  };

  /** The readings file's entries, newest state (called at write time). */
  const entriesForFile = () => harden([...fileEntries.values()]);

  // ---------------------------------------------------------- the channel

  /**
   * @typedef {object} Subscriber
   * @property {number} seen the `rev` last answered (-1: none yet)
   * @property {number} lastCallMs the last `next()` call (or the `watch`)
   * @property {{ resolve: (value: any) => void, reject: (reason: any) => void, promise: Promise<any> } | undefined} waiting
   * @property {(() => void) | undefined} cancelKeepalive
   * @property {boolean} closed
   */

  // In `watch` order (oldest first).
  /** @type {Set<Subscriber>} */
  const subscribers = new Set();

  /** @param {Subscriber} sub */
  const isIdle = sub =>
    sub.waiting === undefined && now() - sub.lastCallMs >= idleMs;

  /** @param {Subscriber} sub */
  const closeSubscriber = sub => {
    if (sub.closed) return;
    sub.closed = true;
    subscribers.delete(sub);
    sub.cancelKeepalive?.();
    sub.cancelKeepalive = undefined;
    const { waiting } = sub;
    sub.waiting = undefined;
    waiting?.reject(Error(m4Texts.accountsWatchClosed));
  };

  /** Evict every idle subscriber (oldest first: `subscribers` is in watch order). */
  const sweep = () => {
    for (const sub of subscribers) if (isIdle(sub)) closeSubscriber(sub);
  };

  /** @param {Subscriber} sub */
  const answer = sub => {
    const { waiting } = sub;
    if (waiting === undefined) return;
    sub.cancelKeepalive?.();
    sub.cancelKeepalive = undefined;
    sub.waiting = undefined;
    const current = view();
    sub.seen = current.rev;
    waiting.resolve(current);
  };

  const publish = () => {
    rev += 1;
    sweep();
    for (const sub of subscribers) if (sub.waiting !== undefined) answer(sub);
  };

  /** @param {number | undefined} fromRev */
  const makeSubscription = fromRev => {
    /** @type {Subscriber} */
    const sub = {
      seen: fromRev === undefined ? -1 : fromRev,
      lastCallMs: now(),
      waiting: undefined,
      cancelKeepalive: undefined,
      closed: false,
    };
    subscribers.add(sub);
    return makeExo('AccountsSubscription', m4Interfaces.AccountsSubscription, {
      next: async () => {
        if (!sub.closed && isIdle(sub)) closeSubscriber(sub);
        if (sub.closed) throw Error(m4Texts.accountsWatchClosed);
        sub.lastCallMs = now();
        if (sub.waiting !== undefined) return sub.waiting.promise;
        const current = view();
        if (sub.seen !== current.rev) {
          sub.seen = current.rev;
          return current;
        }
        const kit = makePromiseKit();
        sub.waiting = kit;
        sub.cancelKeepalive = timers.after(keepaliveMs, () => {
          sub.cancelKeepalive = undefined;
          answer(sub);
        });
        return kit.promise;
      },
      close: () => {
        closeSubscriber(sub);
      },
    });
  };

  // ---------------------------------------------------------- changes

  /**
   * Keep a reading of a member (no publish).
   * @param {MemberEntry} entry
   * @param {Reading} candidate
   * @returns {boolean} whether it was kept
   */
  const keepReading = (entry, candidate) => {
    ensureLoaded();
    const reading = checkReading(candidate, 'observed');
    if (reading === undefined) return false;
    const previous = readingOfMember.get(entry.member);
    if (
      previous !== undefined &&
      previous.source === 'observed' &&
      previous.at > reading.at
    )
      return false;
    const kept = harden(reading);
    readingOfMember.set(entry.member, kept);
    if (fileEntries.has(entry.key) || fileEntries.size < m4Limits.maxMembers) {
      fileEntries.set(entry.key, {
        key: entry.key,
        provider: entry.provider,
        reading: kept,
      });
      writer.update(entriesForFile);
    }
    return true;
  };

  /**
   * A refresh of this member failed: its reading is no longer observed.
   * @param {MemberEntry} entry
   */
  const demote = entry => {
    const own = readingOfMember.get(entry.member);
    if (own === undefined || own.source === 'remembered') return false;
    readingOfMember.set(entry.member, harden({ ...own, source: 'remembered' }));
    return true;
  };

  /**
   * @param {any} backend
   * @param {PoolInfo} info
   */
  const keepPool = (backend, info) => {
    if (!pools.has(backend) && pools.size >= m4Limits.maxPools) {
      // The oldest registration goes first (the manager keeps at most
      // `maxPools` itself, so this happens only after retirements).
      const [oldest] = pools.keys();
      pools.delete(oldest);
    }
    pools.set(
      backend,
      harden({
        kind: info.kind,
        label: info.label,
        members: harden([...info.members].slice(0, m4Limits.maxPoolMembers)),
      }),
    );
  };

  /** @param {any} backend */
  const poolInfoOf = async backend => {
    const known = pools.get(backend);
    if (known !== undefined) return known;
    if (readers.describe === undefined) return undefined;
    const info = await readers.describe(backend);
    if (info === undefined) return undefined;
    keepPool(backend, info);
    publish();
    return pools.get(backend);
  };

  /**
   * The usage read of each member in flight (single flight per member;
   * bounded by the members registered).
   * @type {Map<any, Promise<Reading | undefined>>}
   */
  const readsInFlight = new Map();
  /**
   * When each member's last usage read started (any path).
   * @type {WeakMap<any, number>}
   */
  const lastReadAt = new WeakMap();

  /**
   * One usage read of a member, shared by concurrent refreshes.
   * @param {(backend: any, member: MemberEntry) => Promise<Reading | undefined>} usage
   * @param {any} backend
   * @param {MemberEntry} entry
   */
  const readOnce = (usage, backend, entry) => {
    const known = readsInFlight.get(entry.member);
    if (known !== undefined) return known;
    lastReadAt.set(entry.member, now());
    const flight = usage(backend, entry).finally(() => {
      readsInFlight.delete(entry.member);
    });
    readsInFlight.set(entry.member, flight);
    return flight;
  };

  /**
   * Read the providers now for these pools' active members (each member
   * once, however many pools it is in); one publish at the end. A member
   * read less than `minIntervalMs` ago and not in flight is skipped.
   * @param {any[]} backends
   * @param {number} [minIntervalMs]
   */
  const refreshPools = async (backends, minIntervalMs = 0) => {
    ensureLoaded();
    if (readers.usage === undefined) return;
    const usage = readers.usage;
    /** @type {Map<any, { backend: any, entry: MemberEntry }>} */
    const targets = new Map();
    for (const backend of backends) {
      for (const entry of pools.get(backend)?.members ?? []) {
        const last = lastReadAt.get(entry.member);
        const recent =
          minIntervalMs > 0 &&
          !readsInFlight.has(entry.member) &&
          last !== undefined &&
          now() - last < minIntervalMs;
        if (entry.state === 'active' && !recent && !targets.has(entry.member))
          targets.set(entry.member, { backend, entry });
      }
    }
    const results = await Promise.allSettled(
      [...targets.values()].map(async ({ backend, entry }) => ({
        entry,
        reading: await readOnce(usage, backend, entry),
      })),
    );
    let changed = false;
    const entries = [...targets.values()];
    results.forEach((result, index) => {
      const { entry } = entries[index];
      if (result.status === 'fulfilled' && result.value.reading !== undefined) {
        if (keepReading(entry, result.value.reading)) changed = true;
      } else if (demote(entry)) {
        changed = true;
      }
    });
    if (changed) publish();
  };

  // ---------------------------------------------------------- the exo

  const accounts = makeExo('Accounts', m4Interfaces.Accounts, {
    list: () => view(),
    /** @param {any} backend */
    forBackend: async backend => {
      ensureLoaded();
      const info = await poolInfoOf(backend);
      return info === undefined ? undefined : poolAccounts(backend, info);
    },
    /** @param {any} session */
    forSession: async session => {
      ensureLoaded();
      let backend = poolOfSession.get(session);
      if (backend === undefined && readers.poolOf !== undefined)
        backend = await readers.poolOf(session);
      if (backend === undefined) return undefined;
      const info = await poolInfoOf(backend);
      return info === undefined ? undefined : poolAccounts(backend, info);
    },
    /** @param {any} [backend] */
    refresh: async backend => {
      if (backend === undefined) await refreshPools([...pools.keys()]);
      else if ((await poolInfoOf(backend)) !== undefined)
        await refreshPools([backend]);
      return view();
    },
    /** @param {number} [fromRev] */
    watch: fromRev => {
      sweep();
      if (subscribers.size >= maxSubscribers)
        throw Error(accountsWatchLimitText);
      // A `rev` that is not the current one (older, or from an earlier
      // incarnation whose revs ran higher) is answered at once.
      return makeSubscription(
        fromRev !== undefined && fromRev === rev ? fromRev : undefined,
      );
    },
  });

  // ---------------------------------------------------------- the core

  return harden({
    accounts,
    observe: (backend, member, reading) => {
      if (keepReading(member, reading)) publish();
    },
    memberState: (backend, member, state, code, markedUntilMs) => {
      const previous = stateOfMember.get(member.member);
      if (
        previous !== undefined &&
        previous.state === state &&
        previous.code === code &&
        previous.markedUntilMs === markedUntilMs
      )
        return;
      stateOfMember.set(member.member, {
        state,
        ...(code === undefined ? {} : { code }),
        ...(markedUntilMs === undefined ? {} : { markedUntilMs }),
      });
      publish();
    },
    /**
     * The model's refresh (`accountStatus { refresh: true }`): the pool's
     * members not read in the last `modelRefreshMs`.
     * @param {any} backend
     */
    refreshForModel: async backend => {
      if ((await poolInfoOf(backend)) !== undefined)
        await refreshPools([backend], modelRefreshMs);
    },
    sessionOpened: (backend, session) => {
      poolOfSession.set(session, backend);
    },
    register: (backend, info) => {
      ensureLoaded();
      keepPool(backend, info);
      publish();
    },
    statusText: (backend, usage) =>
      renderAccountStatus(
        pools.has(backend)
          ? poolAccounts(backend, /** @type {PoolInfo} */ (pools.get(backend)))
          : undefined,
        usage,
      ),
    flush: () => writer.flush(),
    rev: () => rev,
    subscriberCount: () => subscribers.size,
    close: async () => {
      for (const sub of [...subscribers]) closeSubscriber(sub);
      await writer.close();
    },
  });
};
harden(makeAccounts);

// ------------------------------------------------------------ rendering

/**
 * How a figure should be read (Fae `session/account-tool.js` `provenance`).
 * @param {string} provenance
 * @param {string | undefined} at
 */
const provenanceText = (provenance, at) => {
  const when = at === undefined ? '' : ` as of ${at}`;
  switch (provenance) {
    case 'observed':
      return `${m4Texts.provenanceObserved}: read from the provider${when}`;
    case 'declared':
      return `${m4Texts.provenanceDeclared}: declared by the operator, not measured`;
    case 'remembered':
      return `${m4Texts.provenanceRemembered}: last reading${when}; the provider has not been read since`;
    default:
      return `${m4Texts.provenanceUnavailable}: not published by this provider`;
  }
};

/**
 * A window's title (codex-sandbox `codex-account-read.js` `titleOfSeconds`).
 * @param {{ name: string, windowMinutes?: number }} window
 */
const windowTitle = window => {
  const minutes = window.windowMinutes;
  if (minutes === 300) return '5-hour window';
  if (minutes === 10_080) return 'Weekly window';
  if (minutes !== undefined && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
    return `${minutes}-minute window`;
  }
  return `${window.name} window`;
};

/** @param {number} value */
const percent = value => `${Math.round(value)}%`;

/**
 * The `accountStatus` text (Fae `session/account-tool.js` rendering):
 * selection mode, per account its plan, state, windows with remaining,
 * percent used and reset, each labelled with its provenance; the session's
 * token usage, not attributed; no cost; no reset authority. Banked reset
 * credits are listed read-only (R4-86, decision 8). Cut to the tool output
 * limit (`m4Limits.accountTextUnits`).
 *
 * @param {any} pool a `PoolAccounts`, or undefined for a backend that is
 *   not a pool (R4-91: the API account profile is unavailable)
 * @param {any} [usage] `UsageTotals` of the session, when read
 */
export const renderAccountStatus = (pool, usage) => {
  /** @type {string[]} */
  const lines = [];
  if (pool === undefined) {
    lines.push(`${m4Texts.noSubscriptionAccounts}.`);
  } else {
    lines.push(
      `Account selection: ${pool.selection} (subscription pool "${pool.label}"). These are configured accounts, not proof of runtime eligibility or the payer for previous turns.`,
    );
    if (pool.members.length === 0)
      lines.push('No matching account is currently published.');
    for (const account of pool.members) {
      const state =
        account.state === 'marked' && account.markedUntil !== undefined
          ? `marked until ${account.markedUntil}`
          : account.state;
      lines.push(
        `Account: ${account.label} (${account.provider}) — state ${state}${
          account.code === undefined ? '' : ` (${account.code})`
        }.`,
      );
      const source = provenanceText(account.provenance, account.at);
      if (account.plan !== undefined)
        lines.push(`  Plan: ${account.plan} (${source}).`);
      if (account.windows.length === 0) {
        lines.push(`  Rate limits: ${source}.`);
      } else {
        lines.push(`  Rate limits (${source}):`);
        for (const window of account.windows)
          lines.push(
            `    - ${windowTitle(window)}: ${percent(
              100 - window.usedPercent,
            )} remaining (${percent(window.usedPercent)} used)${
              window.resetsAt === undefined ? '' : `, resets ${window.resetsAt}`
            }`,
          );
      }
      if (account.limitReached)
        lines.push(
          '  The provider says this account may not spend now (limit reached).',
        );
      if (account.credits !== undefined)
        lines.push(`  Credits: ${account.credits} (${source}).`);
      if (account.banked !== undefined && account.banked.length !== 0) {
        lines.push(
          `  Banked reset credits: ${account.banked.length} (shown only; they are not redeemed here):`,
        );
        for (const credit of account.banked)
          lines.push(
            `    - ${credit.label ?? 'reset credit'}${
              credit.expiresAt === undefined
                ? ''
                : `, expires ${credit.expiresAt}`
            }`,
          );
      }
    }
  }
  if (usage !== undefined)
    lines.push(
      `This session has used ${usage.inputTokens} input and ${usage.outputTokens} output tokens (not attributed to individual accounts).`,
    );
  lines.push(usageNotAttributedText);
  return boundToolOutput(lines.join('\n'), m4Limits.accountTextUnits);
};
harden(renderAccountStatus);

// ------------------------------------------------------------ usage reads

/** @param {unknown} value */
const finite = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * A Claude usage answer as a `Reading` (claude-sandbox
 * `subscription-auth.js` `readingFromClaudeUsage`): `five_hour` and
 * `seven_day` utilisation with their reset times. Tolerant: what cannot be
 * read is left out. Nothing of the payload but numbers and times is kept.
 *
 * @param {any} payload
 * @param {number} nowMs
 * @returns {Reading}
 */
export const readingFromClaudeUsage = (payload, nowMs) => {
  /** @type {ReadingWindow[]} */
  const windows = [];
  for (const [field, name, windowMinutes] of /** @type {const} */ ([
    ['five_hour', 'primary', 300],
    ['seven_day', 'secondary', 10_080],
  ])) {
    const window = payload?.[field];
    const utilization = finite(window?.utilization);
    if (utilization !== undefined) {
      const reset =
        typeof window.resets_at === 'string'
          ? Date.parse(window.resets_at)
          : NaN;
      windows.push({
        name,
        usedPercent: Math.min(100, utilization),
        windowMinutes,
        ...(Number.isFinite(reset) ? { resetsAtMs: reset } : {}),
      });
    }
  }
  return harden({
    at: nowMs,
    source: 'observed',
    windows,
    limitReached: windows.some(window => window.usedPercent >= 100),
  });
};
harden(readingFromClaudeUsage);

/** The plan titles codex-sandbox `codex-account-read.js` knows. */
const CODEX_PLAN_TITLES = harden({
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  team: 'Team',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  business: 'Business',
  ent26: 'Enterprise',
  enterprise_cbp_automation: 'Enterprise',
  enterprise_cbp_usage_based: 'Enterprise',
  enterprise: 'Enterprise',
  edu: 'Edu',
  edu_plus: 'Edu',
  edu_pro: 'Edu',
});

/**
 * Epoch seconds as ms, when plausible (2020..2100, as the reference).
 * @param {unknown} seconds
 */
const instantMs = seconds => {
  const value = finite(seconds);
  if (value === undefined || value < 1_577_836_800 || value > 4_102_444_800)
    return undefined;
  return Math.trunc(value) * 1000;
};

/**
 * A Codex usage answer as a `Reading` (codex-sandbox
 * `codex-account-read.js` `readingFromCodexUsage`): plan, primary and
 * secondary windows, credit balance, banked reset credits (shown, never
 * redeemed: decision 8). A plan this does not know is `Unknown plan`, not
 * the backend's word; no description text of the backend's is kept.
 *
 * @param {any} payload
 * @param {number} nowMs
 * @returns {Reading}
 */
export const readingFromCodexUsage = (payload, nowMs) => {
  /** @type {Reading} */
  const reading = {
    at: nowMs,
    source: 'observed',
    windows: [],
    limitReached: false,
  };
  if (payload === null || typeof payload !== 'object') return harden(reading);
  if (typeof payload.plan_type === 'string')
    reading.plan = Object.hasOwn(CODEX_PLAN_TITLES, payload.plan_type)
      ? CODEX_PLAN_TITLES[
          /** @type {keyof typeof CODEX_PLAN_TITLES} */ (payload.plan_type)
        ]
      : 'Unknown plan';
  const limit = payload.rate_limit;
  if (limit !== null && typeof limit === 'object') {
    for (const [field, name] of /** @type {const} */ ([
      ['primary_window', 'primary'],
      ['secondary_window', 'secondary'],
    ])) {
      const snapshot = limit[field];
      const usedPercent =
        snapshot !== null && typeof snapshot === 'object'
          ? finite(snapshot.used_percent)
          : undefined;
      if (usedPercent !== undefined) {
        const seconds = finite(snapshot.limit_window_seconds);
        const resetsAtMs = instantMs(snapshot.reset_at);
        reading.windows.push({
          name,
          usedPercent: Math.min(100, usedPercent),
          ...(seconds !== undefined &&
          Number.isSafeInteger(seconds) &&
          seconds > 0
            ? { windowMinutes: Math.round(seconds / 60) }
            : {}),
          ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
        });
      }
    }
  }
  reading.limitReached =
    limit?.limit_reached === true ||
    typeof payload.rate_limit_reached_type === 'string';
  const credits = payload.credits;
  if (credits !== null && typeof credits === 'object') {
    if (credits.unlimited === true) reading.credits = 'unlimited';
    else if (
      typeof credits.balance === 'string' &&
      /^-?\d{1,24}(\.\d{1,12})?$/.test(credits.balance)
    )
      reading.credits = credits.balance;
  }
  const resets = payload.rate_limit_reset_credits;
  if (resets !== null && typeof resets === 'object') {
    const rows = Array.isArray(resets.credits) ? resets.credits : [];
    /** @type {{ expiresAtMs?: number }[]} */
    const banked = rows
      .filter(
        (/** @type {any} */ row) =>
          row !== null &&
          typeof row === 'object' &&
          (row.status === undefined || row.status === 'available'),
      )
      .slice(0, m4Limits.maxBankedCredits)
      .map((/** @type {any} */ row) => {
        const expiresAtMs = instantMs(row.expires_at);
        return expiresAtMs === undefined ? {} : { expiresAtMs };
      });
    // Only the count is known for the rest.
    const count = finite(resets.available_count);
    const known =
      count !== undefined && Number.isSafeInteger(count)
        ? Math.min(count, m4Limits.maxBankedCredits)
        : 0;
    while (banked.length < known) banked.push({});
    reading.banked = banked;
  }
  return harden(reading);
};
harden(readingFromCodexUsage);

/** A usage answer over this is refused (as the references). */
const USAGE_MAX_BYTES = 262_144;
const USAGE_TIMEOUT_MS = 20_000;

/**
 * A usage read that failed; the message is a fixed code and an HTTP status
 * at most, never a body, a header value or a token.
 */
export class UsageReadFailure extends Error {
  /**
   * @param {string} code an `m4Codes` entry
   * @param {number} [status]
   */
  constructor(code, status) {
    super(
      status === undefined
        ? `usage read failed: ${code}`
        : `usage read failed: ${code} (HTTP ${status})`,
    );
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
harden(UsageReadFailure);

/**
 * The bounded JSON of a 2xx body.
 * @param {Response} response
 */
const boundedJson = async response => {
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  if (response.body !== null) {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
      /** @type {unknown} */ (response.body)
    )) {
      total += chunk.byteLength;
      if (total > USAGE_MAX_BYTES) {
        response.body.cancel().catch(() => {});
        throw new UsageReadFailure('READ_FAILED');
      }
      parts.push(chunk);
    }
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
    );
  } catch {
    throw new UsageReadFailure('READ_FAILED');
  }
};

/**
 * The on-demand usage reader `makeAccounts` takes as `readers.usage`
 * (claude-sandbox `makeClaudeAccountRead`, codex-sandbox
 * `makeCodexAccountRead`). The URL and the access token come from the
 * caller (W4.6: the pool spec's `usageUrl` or the provider default, and the
 * member's credential as it stands: no renewal on an account read). A
 * member or pool with no URL is not read (undefined). Redirects are
 * refused; a non-2xx answer fails with its status only.
 *
 * @param {object} options
 * @param {(backend: any, member: MemberEntry) => string | undefined} options.url
 * @param {(member: MemberEntry) => Promise<{ accessToken: string, accountId?: string }>} options.credential
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs]
 * @returns {(backend: any, member: MemberEntry) => Promise<Reading | undefined>}
 */
export const makeUsageReader =
  ({
    url,
    credential,
    fetch = globalThis.fetch,
    now = Date.now,
    timeoutMs = USAGE_TIMEOUT_MS,
  }) =>
  async (backend, member) => {
    const target = url(backend, member);
    if (target === undefined) return undefined;
    const { accessToken, accountId } = await credential(member);
    /** @type {Record<string, string>} */
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    };
    if (member.provider === 'claude')
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    else if (accountId !== undefined) headers['chatgpt-account-id'] = accountId;
    /** @type {Response} */
    let response;
    try {
      response = await fetch(target, {
        method: 'GET',
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UsageReadFailure('UNREACHABLE');
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw new UsageReadFailure(
        response.status === 401 ? 'REJECTED' : 'READ_FAILED',
        response.status,
      );
    }
    const payload = await boundedJson(response);
    return member.provider === 'claude'
      ? readingFromClaudeUsage(payload, now())
      : readingFromCodexUsage(payload, now());
  };
harden(makeUsageReader);
