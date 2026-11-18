// @ts-check
/**
 * The M4 interface contract (milestones.md M4 W4.0;
 * `designs/m4-interfaces.md`): the guards, record shapes and method names
 * of every object M4 adds, and the M4 versions of the two M2 interfaces M4
 * extends (`SecretsAdmin`, `Secret`).
 *
 * One-way dependency: this module imports `interfaces.js` (`shapes`), never
 * the reverse, so nothing here reaches a bundle that does not import it.
 * Importers: the manager vat's subscriptions part
 * (`resources/agent-host/durable-subscriptions.js`), the adapter
 * (`AH/subscriptions/`, `AH/secrets/`, `AH/attach.js`), the factory's
 * effort resolver (texts only, from `subscription-texts.js`), the gateway key guard
 * (M3's vocabulary loader reads `vocabularyShapes()` below) and tests. The session and exec
 * programs never import it (their bundles have no room, m4-interfaces 1.4).
 *
 * Rules as `interfaces.js`: closed records with a fixed key vocabulary
 * (rule 12.10), every string and array bounded (`limits.js`,
 * `subscription-limits.js`), objects by presence, never by name or id. Changing a
 * guard here is a contract change (`contract(thixotrope-harness): ...`,
 * m4-interfaces.md updated in the same commit).
 *
 * Runs in vats (prelude globals) and in Node after `installGuestPrelude()`.
 */
import { limits } from './limits.js';
import { subscriptionLimits } from './subscription-limits.js';
import { shapes } from './interfaces.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

// ---------------------------------------------------------------- helpers
// The same helpers as interfaces.js (not exported there; kept equal).

/** @param {number} units */
const text = units => M.string({ stringLengthLimit: units });
/**
 * @param {any} shape
 * @param {number} length
 */
const list = (shape, length) => M.arrayOf(shape, { arrayLengthLimit: length });
/**
 * A closed record (rule 12.10).
 * @param {Record<string, any>} required
 * @param {Record<string, any>} [optional]
 */
const record = (required, optional = {}) =>
  M.splitRecord(required, optional, {});
const count = M.and(M.number(), M.gte(0));
/** @param {string} label */
const R = label => M.remotable(label);
const done = M.undefined();
/** @param {number} most */
const atMost = most => M.and(count, M.lte(most));

/**
 * A record whose properties are built on first read and kept (as
 * `interfaces.js` `lazyTable`: building every guard eagerly costs a vat
 * hundreds of ms in its loading crank, J-0201).
 * @template {Record<string, () => any>} T
 * @param {T} builders
 * @returns {{ readonly [K in keyof T]: ReturnType<T[K]> }}
 */
const lazyTable = builders => {
  /** @type {Map<string, any>} */
  const built = new Map();
  /** @type {any} */
  const table = {};
  for (const [name, build] of Object.entries(builders)) {
    // The names are this module's own table keys, fixed in its source.
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    Object.defineProperty(table, name, {
      enumerable: true,
      get: () => {
        if (!built.has(name)) built.set(name, build());
        return built.get(name);
      },
    });
  }
  return harden(table);
};

const S = shapes;

// ---------------------------------------------------------------- shapes

const m4ShapeBuilders = {
  // ---- pools (section 3; R4-24, R4-90, R4-103, R8-13) ----

  /** A member's provider. */
  Provider: () => M.or('claude', 'codex'),
  /** The two pool kinds; `BackendKind` is widened with them (H-1). */
  PoolKind: () => M.or('claude-pool', 'codex-pool'),
  /**
   * An operator-declared account profile (R4-84 `declared`, R8-14): what the
   * operator says the plan is; never measured, never a credential.
   */
  DeclaredProfile: () =>
    record(
      {},
      {
        plan: text(subscriptionLimits.planUnits),
        windows: list(T.Window, subscriptionLimits.maxWindows),
      },
    ),
  /** `SubscriptionsAdmin.makeMember` argument (R8-13, R8-35, R8-36). */
  NewMember: () =>
    record(
      {
        provider: T.Provider,
        label: S.Label,
        credential: R('Secret'),
      },
      {
        weight: atMost(subscriptionLimits.maxWeight),
        declared: T.DeclaredProfile,
      },
    ),
  /** `PoolMember.describe()`: never the credential or its key. */
  MemberInfo: () =>
    record(
      {
        provider: T.Provider,
        label: S.Label,
        weight: count,
        state: M.or('active', 'retired'),
      },
      { declared: T.DeclaredProfile },
    ),
  /**
   * `SubscriptionsAdmin.makePool` argument, kept by the manager as the pool
   * Backend's spec and passed to the adapter with each `open`, `listModels`
   * and `resolveModel` (the ops guard admits it beside `BackendSpec`, H-4).
   * `baseUrl`, `tokenUrl` and `usageUrl` point tests at the fake servers
   * (F.2 c); absent, the provider's own endpoints from the reference
   * modules. `contextLength` is open decision 13 (Claude's catalogue has
   * none).
   */
  PoolSpec: () =>
    record(
      {
        kind: T.PoolKind,
        label: S.Label,
        members: list(R('PoolMember'), subscriptionLimits.maxPoolMembers),
      },
      {
        modelId: S.ModelId,
        contextLength: count,
        maxOutputTokens: count,
        // INT-M4: as M2's BackendSpec since its review (at least 1 s).
        timeoutMs: M.and(count, M.gte(1000), M.lte(limits.maxTurnDeadlineMs)),
        cacheLifetimeMs: count,
        baseUrl: text(limits.urlUnits),
        tokenUrl: text(limits.urlUnits),
        usageUrl: text(limits.urlUnits),
        logPath: text(4096),
      },
    ),
  /** A pool Backend's `describe()` (the `BackendInfo` shape, pool kinds). */
  PoolInfo: () =>
    record({ kind: T.PoolKind, label: S.Label }, { modelId: S.ModelId }),
  /** `SubscriptionsAdmin.describePool(pool)`. */
  PoolDescription: () =>
    record({
      kind: T.PoolKind,
      label: S.Label,
      members: list(R('PoolMember'), subscriptionLimits.maxPoolMembers),
      state: M.or('active', 'retired'),
    }),
  MemberPage: () =>
    record(
      { members: list(R('PoolMember'), subscriptionLimits.poolPageEntries) },
      { next: S.Cursor },
    ),
  PoolPage: () =>
    record({ pools: list(R('Backend'), subscriptionLimits.maxPools) }),
  /**
   * A refusal mark (hosted-agent `subscription-pool.js` `makeRefusalMarks`):
   * skip the member until `untilMs`; `strikes` in a row double the undated
   * pause (R4-103); `dated` when the refusal named its reset time, so a newer
   * open reading lifts it (R4-25).
   */
  Mark: () =>
    record({
      untilMs: count,
      strikes: count,
      sinceMs: count,
      dated: M.boolean(),
    }),
  /**
   * One member as the adapter needs it (`AgentHostSink.poolState`). `key` is
   * the credential's store key (`k<n>`): it never leaves the manager-adapter
   * pair (M1b 17.3).
   */
  MemberState: () =>
    record(
      {
        member: R('PoolMember'),
        label: S.Label,
        provider: T.Provider,
        weight: count,
        key: S.Id,
        state: M.or('active', 'retired'),
      },
      { mark: T.Mark, declared: T.DeclaredProfile },
    ),
  /** Where a session was last served (R4-24, R4-103). */
  ServedRecord: () =>
    record({ session: R('Session'), member: R('PoolMember'), at: count }),
  /** `AgentHostSink.poolState(pool)`: one manager crank per pool per incarnation. */
  PoolState: () =>
    record({
      state: M.or('active', 'retired'),
      members: list(T.MemberState, subscriptionLimits.maxPoolMembers),
      served: list(T.ServedRecord, subscriptionLimits.servedRecords),
    }),
  /** One mark change: `mark` absent means the mark was lifted. */
  MarkChange: () => record({ member: R('PoolMember') }, { mark: T.Mark }),
  /** `AgentHostSink.poolChanged(pool, change)`, sendOnly, coalesced (section 5.1). */
  PoolChange: () =>
    record(
      {},
      {
        marks: list(T.MarkChange, subscriptionLimits.maxPoolMembers),
        served: list(T.ServedRecord, subscriptionLimits.poolChangeServed),
      },
    ),
  /** `PoolBackend.resolveEffort` argument (R4-23). */
  EffortRequest: () =>
    record(
      { modelId: S.ModelId },
      { reasoningEffort: text(limits.effortUnits) },
    ),
  /** The effort a creation stores; absent: the provider default. */
  EffortAnswer: () => record({}, { reasoningEffort: text(limits.effortUnits) }),

  // ---- secrets, full (section 4; R6-67, R7-22..R7-26, R7-63) ----

  /** One catalogue entry: never the value (R7-26). */
  SecretCatalogEntry: () =>
    record({
      secret: R('Secret'),
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
      generation: count,
      state: M.or('active', 'revoked'),
      bytes: count,
    }),
  SecretCatalogPage: () =>
    record(
      {
        entries: list(
          T.SecretCatalogEntry,
          subscriptionLimits.catalogPageEntries,
        ),
      },
      { next: S.Cursor },
    ),
  /** `CredentialOps.describeSecrets` answer item; `null` for an unknown key. */
  SecretKeyInfo: () =>
    M.or(
      null,
      record({
        key: S.Id,
        generation: count,
        state: M.or('active', 'revoked'),
        bytes: count,
      }),
    ),
  /** `AuditReader.page` argument; `before` is an event time (ms) to page back from. */
  AuditQuery: () =>
    record(
      {},
      {
        secret: R('Secret'),
        limit: atMost(subscriptionLimits.auditReaderMax),
        before: count,
      },
    ),
  /** Newest first; `next` is the `before` of the following page. */
  AuditReaderPage: () =>
    record(
      { events: list(S.AuditEvent, subscriptionLimits.auditReaderMax) },
      { next: count },
    ),

  // ---- accounts (section 6; R4-84, R4-85, R6-54) ----

  /** R4-84: where a figure comes from. */
  Provenance: () => M.or('observed', 'declared', 'remembered', 'unavailable'),
  /** A rate-limit window (`account.js` `normalizeRateLimitWindow`). */
  Window: () =>
    record(
      {
        name: M.or('primary', 'secondary', 'other'),
        usedPercent: atMost(100),
      },
      {
        resetsAt: text(subscriptionLimits.timeUnits),
        windowMinutes: count,
      },
    ),
  /** A banked Codex reset credit (R4-86): shown, never redeemed (decision 8). */
  BankedCredit: () =>
    record(
      {},
      { expiresAt: text(subscriptionLimits.timeUnits), label: S.Label },
    ),
  /** One member's account as a person or the model sees it. */
  MemberAccount: () =>
    record(
      {
        label: S.Label,
        provider: T.Provider,
        provenance: T.Provenance,
        state: M.or('ok', 'marked', 'unusable', 'retired'),
        windows: list(T.Window, subscriptionLimits.maxWindows),
        limitReached: M.boolean(),
      },
      {
        plan: text(subscriptionLimits.planUnits),
        credits: text(subscriptionLimits.planUnits),
        banked: list(T.BankedCredit, subscriptionLimits.maxBankedCredits),
        at: text(subscriptionLimits.timeUnits),
        markedUntil: text(subscriptionLimits.timeUnits),
        code: text(limits.secretCodeUnits),
      },
    ),
  /** The accounts behind one pool backend (R4-84: selection is always `auto`). */
  PoolAccounts: () =>
    record({
      backend: R('Backend'),
      kind: T.PoolKind,
      label: S.Label,
      selection: 'auto',
      members: list(T.MemberAccount, subscriptionLimits.maxPoolMembers),
    }),
  /**
   * Every pool's accounts. Adapter-local: never enters a vat (8 pools x 16
   * members can exceed frameBytes; it travels gateway -> browser only).
   */
  AccountsView: () =>
    record({
      rev: count,
      pools: list(T.PoolAccounts, subscriptionLimits.maxPools),
    }),
  /**
   * One push of the accounts channel (D-8; R4-85: pushed, never polled).
   * `closed`: the adapter ended this watch (HR-SYN-34, as the session and
   * list channels answer `{ closed, reason }`): `reason` is `idle` (evicted
   * after `accountsIdleMs` without a call), `client` (the viewer's
   * `close()`) or `stopped` (the adapter's accounts core closed); `pools` is
   * then empty and the viewer watches again.
   */
  AccountsBatch: () =>
    record(
      {
        rev: count,
        pools: list(T.PoolAccounts, subscriptionLimits.maxPools),
      },
      { closed: M.boolean(), reason: M.or('idle', 'client', 'stopped') },
    ),
};

/** Shapes of M4, by name (built on first use). */
export const m4Shapes = lazyTable(m4ShapeBuilders);
const T = m4Shapes;

// ---------------------------------------------------------------- interfaces

/** M2's SecretsAdmin methods, kept equal to `interfaces.SecretsAdmin` (W4.1 test). */
const secretsAdminM2Methods = () => ({
  list: M.call().optional(S.Cursor).returns(S.SecretPage),
  create: M.callWhen(S.NewSecret).returns(R('Secret')),
  openWriter: M.callWhen().returns(R('SecretWriter')),
  audit: M.callWhen()
    .optional(atMost(limits.auditPageEvents))
    .returns(S.AuditPage),
});
/** M2's Secret methods, kept equal to `interfaces.Secret` (W4.1 test). */
const secretM2Methods = () => ({
  describe: M.callWhen().returns(S.SecretInfo),
  makeReadGrant: M.call().returns(R('ReadGrant')),
  revoke: M.callWhen().returns(done),
  delete: M.callWhen().returns(done),
  audit: M.callWhen()
    .optional(atMost(limits.auditPageEvents))
    .returns(S.AuditPage),
});

/**
 * The sink methods M4 adds to `AgentHostSink` (durable.js spreads these
 * guards, H-3). The adapter is the only caller.
 */
export const m4SinkMethodGuards = () =>
  harden({
    poolState: M.call(R('Backend')).returns(T.PoolState),
    poolChanged: M.call(R('Backend'), T.PoolChange).returns(done),
    poolOf: M.call(R('Session')).returns(M.or(done, R('Backend'))),
  });

const m4InterfaceBuilders = {
  // ---- manager vat (durable; W4.1) ----

  /** Pools and members (section 3.1); reached from `SecretsAdmin.subscriptions()`. */
  SubscriptionsAdmin: () =>
    M.interface('SubscriptionsAdmin', {
      makeMember: M.call(T.NewMember).returns(R('PoolMember')),
      listMembers: M.call().optional(S.Cursor).returns(T.MemberPage),
      makePool: M.call(T.PoolSpec).returns(R('Backend')),
      listPools: M.call().returns(T.PoolPage),
      describePool: M.call(R('Backend')).returns(T.PoolDescription),
      // XB, X-FIX: answers once the adapter has taken the push (3.1).
      retirePool: M.callWhen(R('Backend')).returns(done),
      accounts: M.callWhen().returns(R('Accounts')),
    }),
  /** One member account of a pool (R3-233, R8-13). */
  PoolMember: () =>
    M.interface('PoolMember', {
      describe: M.call().returns(T.MemberInfo),
      // XB, X-FIX: answers once the adapter has taken the push (3.1).
      retire: M.callWhen().returns(done),
    }),
  /**
   * A pool backend (exo name `Backend`; held by the factory and sessions):
   * M2's Backend methods plus `resolveEffort`. Nothing on it reaches a
   * member, a credential or the pool's admin.
   */
  PoolBackend: () =>
    M.interface('Backend', {
      describe: M.call().returns(T.PoolInfo),
      open: M.callWhen(R('SessionHostFacet')).returns(S.TurnPorts),
      listModels: M.callWhen().optional(S.ModelRequest).returns(S.ModelPage),
      resolveModel: M.callWhen().optional(S.ModelId).returns(S.ResolvedModel),
      resolveEffort: M.callWhen(T.EffortRequest).returns(T.EffortAnswer),
    }),
  /** M4 version of `SecretsAdmin` (section 4.1): M2's methods first. */
  SecretsAdmin: () =>
    M.interface('SecretsAdmin', {
      ...secretsAdminM2Methods(),
      catalog: M.callWhen().optional(S.Cursor).returns(T.SecretCatalogPage),
      auditReader: M.callWhen().returns(R('AuditReader')),
      subscriptions: M.call().returns(R('SubscriptionsAdmin')),
    }),
  /** M4 version of `Secret` (section 4.1): M2's methods first. */
  Secret: () =>
    M.interface('Secret', {
      ...secretM2Methods(),
      setDescription: M.callWhen(text(limits.secretDescriptionUnits)).returns(
        done,
      ),
    }),

  // ---- agent-host adapter (transient; W4.4, W4.5) ----

  /** Adapter-local; the manager is its only caller (`ops.credentials()`, H-4). */
  CredentialOps: () =>
    M.interface('CredentialOps', {
      describeSecrets: M.callWhen(
        list(S.Id, subscriptionLimits.describeBatch),
      ).returns(list(T.SecretKeyInfo, subscriptionLimits.describeBatch)),
      setSecretDescription: M.callWhen(
        S.Id,
        text(limits.secretDescriptionUnits),
      ).returns(done),
      auditReader: M.call().returns(R('AuditReader')),
      accounts: M.call().returns(R('Accounts')),
      // 3.1 (XB, X-FIX): the manager retired a pool or a member; answered,
      // no argument (every pool this incarnation loaded is asked again at
      // its next use; the retirement returns to the operator only after
      // this answer, so the next turn sees it).
      poolsChanged: M.call().returns(done),
    }),
  /** Adapter-local: audit pages up to 1,000 events, 0 vat deliveries (R7-63). */
  AuditReader: () =>
    M.interface('AuditReader', {
      page: M.callWhen().optional(T.AuditQuery).returns(T.AuditReaderPage),
    }),
  /** Adapter-local: account status (R4-84, R4-85); read-only, no reset authority. */
  Accounts: () =>
    M.interface('Accounts', {
      list: M.call().returns(T.AccountsView),
      forBackend: M.callWhen(R('Backend')).returns(M.or(done, T.PoolAccounts)),
      forSession: M.callWhen(R('Session')).returns(M.or(done, T.PoolAccounts)),
      refresh: M.callWhen().optional(R('Backend')).returns(T.AccountsView),
      watch: M.call().optional(count).returns(R('AccountsSubscription')),
    }),
  /** Adapter-local: one viewer of the accounts channel. */
  AccountsSubscription: () =>
    M.interface('AccountsSubscription', {
      next: M.callWhen().returns(T.AccountsBatch),
      close: M.call().returns(done),
    }),
};

/** M4's interface guards, by name. */
export const m4Interfaces = lazyTable(m4InterfaceBuilders);

/** Method names of `m4Interfaces`, in declaration order. */
export const m4MethodNames = harden({
  SubscriptionsAdmin: [
    'makeMember',
    'listMembers',
    'makePool',
    'listPools',
    'describePool',
    'retirePool',
    'accounts',
  ],
  PoolMember: ['describe', 'retire'],
  PoolBackend: [
    'describe',
    'open',
    'listModels',
    'resolveModel',
    'resolveEffort',
  ],
  SecretsAdmin: [
    'list',
    'create',
    'openWriter',
    'audit',
    'catalog',
    'auditReader',
    'subscriptions',
  ],
  Secret: [
    'describe',
    'makeReadGrant',
    'revoke',
    'delete',
    'audit',
    'setDescription',
  ],
  CredentialOps: [
    'describeSecrets',
    'setSecretDescription',
    'auditReader',
    'accounts',
    'poolsChanged',
  ],
  AuditReader: ['page'],
  Accounts: ['list', 'forBackend', 'forSession', 'refresh', 'watch'],
  AccountsSubscription: ['next', 'close'],
});

/** The sink methods M4 adds (H-3). */
export const m4SinkMethodNames = harden(['poolState', 'poolChanged', 'poolOf']);

/**
 * M3's gateway key guard (m3-interfaces.md 4.4, 6.3) admits the record keys
 * of every pattern reachable from what each `guest/lib/interfaces-m<N>.js`
 * answers here: M4's shapes and its interface guards (their methods'
 * argument and return patterns). Called once per adapter incarnation; it
 * builds every lazy guard of this module. The sink guards are left out: only
 * the adapter calls them, never a browser.
 */
export const vocabularyShapes = () =>
  harden([...Object.values(m4Shapes), ...Object.values(m4Interfaces)]);
