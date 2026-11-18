// @ts-check
/**
 * The agent-host manager's subscriptions part (M4 W4.1;
 * `designs/m4-interfaces.md` sections 3.1, 3.4, 4.1, 5.1, 10): pool members
 * made from Secrets, pool Backends made from members, their refusal marks
 * and last-served records (the durable side of the adapter's selection),
 * and the M4 additions to the Secrets manager (catalogue, description edit,
 * audit reader). `durable.js` builds it once (H-2) and spreads its methods
 * into the sink, the `SecretsAdmin` exo and the `Secret` class.
 *
 * Design rule (architecture 0-3): this vat is the system of record for what
 * persists (members, pools, marks, served records, secret labels and
 * descriptions); the adapter decides per round and does the I/O, and tells
 * this part what changed by `poolChanged` (sendOnly, coalesced); this part
 * tells the adapter of a retirement by `CredentialOps.poolsChanged`
 * (answered, and awaited by the retirement: XB, X-FIX). No value,
 * token or header ever reaches this vat: members hold their credential
 * Secret and its store key `k<n>`, which only the adapter's sink calls see.
 *
 * Objects, not names: a member is its `PoolMember` presence, a pool its
 * `Backend` presence, a session its `Session` presence; labels are the
 * operator's (F.2 a) and are compared only for `makeMember`/`makePool`
 * idempotence (R8-31, R8-23).
 *
 * Runs in a vat: prelude globals only (no clock, timers or randomness),
 * closed records, every retained collection bounded (architecture 12).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import {
  m4Interfaces,
  m4Limits,
  m4Texts,
} from '../../guest/lib/interfaces-m4.js';
import { limits } from '../../guest/lib/limits.js';
import { fitsFrame } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

const { E, makeExo, defineExoClass } = /** @type {any} */ (globalThis);

/** @param {string} code a `secretCodes` entry */
const secretError = code => Error(textOf.secretFailed(code));

/**
 * A pager's cursor (HR-SYN-11): the creation serial of the last row of the
 * page before, so a delete or a retirement between pages skips no row
 * (J-9486). Only canonical decimal digits are one: `Number()` took `1e3`,
 * ` 5` and `0x10`.
 * @param {unknown} cursor
 * @param {string} refusal the text a malformed cursor is refused with
 * @returns {number} 0 for the first page
 */
export const serialCursor = (cursor, refusal) => {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(cursor))
    throw Error(refusal);
  const serial = Number(cursor);
  if (!Number.isSafeInteger(serial)) throw Error(refusal);
  return serial;
};
harden(serialCursor);

/**
 * Pages of the pool catalogue `resolveEffort` reads at most to find the
 * model's row (a pool lists tens of models; 8 x 50 rows is ample).
 */
const EFFORT_PAGES = 8;

/** The optional `PoolSpec` fields, compared for `makePool` idempotence. */
const SPEC_FIELDS = harden([
  'modelId',
  'contextLength',
  'maxOutputTokens',
  'timeoutMs',
  'cacheLifetimeMs',
  'baseUrl',
  'tokenUrl',
  'usageUrl',
  'logPath',
]);

/**
 * @param {string} kind a `PoolKind`
 * @returns {'claude' | 'codex'}
 */
const providerOf = kind => (kind === 'claude-pool' ? 'claude' : 'codex');

/**
 * R7-25: 1-200 characters, no newline (the guard bounds the length); the
 * same rule as `durable.js` `create`.
 * @param {string} description
 */
const assertDescription = description => {
  if (
    description.length === 0 ||
    description.includes('\n') ||
    description.includes('\r')
  )
    throw secretError('INVALID_DESCRIPTION');
};

/**
 * Two pool specs are equal when every field is (members by identity, in
 * order).
 * @param {any} a
 * @param {any} b
 */
const sameSpec = (a, b) => {
  if (a.kind !== b.kind || a.label !== b.label) return false;
  if (a.members.length !== b.members.length) return false;
  if (
    !a.members.every(
      (/** @type {any} */ member, /** @type {number} */ i) =>
        member === b.members[i],
    )
  )
    return false;
  for (const field of SPEC_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  return true;
};

/**
 * @typedef {object} MemberRecord
 * @property {'claude' | 'codex'} provider
 * @property {string} label
 * @property {any} credential the Secret
 * @property {string} key the Secret's store key, kept from creation (a
 *   deleted Secret leaves the member unreadable, never keyless)
 * @property {number} weight
 * @property {any} [declared] `DeclaredProfile`
 * @property {'active' | 'retired'} state
 * @property {number} serial its creation serial, from 1 (`listMembers`
 *   pages by it, HR-SYN-11)
 *
 * @typedef {object} PoolRecord
 * @property {any} spec the `PoolSpec` as given (hardened)
 * @property {'active' | 'retired'} state
 * @property {Map<any, { member: any, at: number }>} served Session -> where
 *   it was last served, least recently served first (R4-103)
 */

/**
 * @param {object} deps
 * @param {<T>(fn: (ops: any) => Promise<T>) => Promise<T>} deps.withOps
 * @param {(host: any) => Promise<any>} deps.whenBound
 * @param {(session: any) => string | null} deps.archiveKeyOf
 * @param {WeakMap<any, { key: string, label: string, description: string }>} deps.secretRecords
 * @param {() => any[]} deps.secretList
 */
export const makeSubscriptionsPart = ({
  withOps,
  whenBound,
  archiveKeyOf,
  secretRecords,
  secretList,
}) => {
  // ---- the adapter's CredentialOps, one per ops facet ----
  /** @type {{ ops: any, credentialOps: any } | undefined} */
  let credentials;
  /**
   * The CredentialOps of the current ops facet: fetched once per adapter
   * incarnation (a retired break re-runs the whole `withOps` call, which
   * then meets a new ops facet and fetches again).
   * @param {any} ops
   */
  const credentialOpsOf = async ops => {
    if (credentials !== undefined && credentials.ops === ops)
      return credentials.credentialOps;
    const credentialOps = await E(ops).credentials();
    credentials = { ops, credentialOps };
    return credentialOps;
  };
  /**
   * @template T
   * @param {(credentialOps: any) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withCredentialOps = fn =>
    withOps(async ops => fn(await credentialOpsOf(ops)));

  /**
   * Tell the adapter that a pool or a member was retired (3.1, XB, X-FIX):
   * `CredentialOps.poolsChanged()`, answered, so the next round of every
   * pool it loaded asks `poolState` again. The retirement is recorded
   * before this is called; `retire` and `retirePool` then wait for this
   * answer, so the adapter has marked its pool states stale before the
   * operator sees the retirement return (the next turn takes another path,
   * operator to session to adapter, and must not overtake the push). The
   * first use in an adapter incarnation first fetches the CredentialOps
   * (one `ops.credentials()` answer). A failure (manager lost, adapter
   * between incarnations) is ignored: a new incarnation loads afresh, and
   * the adapter re-reads after `poolStateRefreshMs` in any case.
   * @returns {Promise<undefined>}
   */
  const announcePoolsChanged = () =>
    withCredentialOps(credentialOps => E(credentialOps).poolsChanged()).then(
      () => undefined,
      () => undefined,
    );

  // ---- members (R8-13, R8-31) ----
  /** PoolMember -> its record. @type {WeakMap<any, MemberRecord>} */
  const memberRecords = new WeakMap();
  /** Active members in creation order (`maxMembers`; retired ones dropped). @type {any[]} */
  let memberList = [];
  /** The last member's creation serial (never reused). */
  let memberSerial = 0;
  /**
   * Refusal marks, per member, shared by every pool the member is in (5.1).
   * @type {WeakMap<any, any>}
   */
  const marks = new WeakMap();

  // ---- pools ----
  /** Backend -> its record. @type {WeakMap<any, PoolRecord>} */
  const poolRecords = new WeakMap();
  /** Active pools in creation order (`maxPools`; retired ones dropped). @type {any[]} */
  let poolList = [];
  /** Session -> the pool it opened (`poolOf`; lost with the session). @type {WeakMap<any, any>} */
  const poolOfSession = new WeakMap();

  /** @param {any} member */
  const memberOf = member => {
    const record = memberRecords.get(member);
    if (record === undefined) throw Error(m4Texts.unknownMember);
    return record;
  };
  /** @param {any} pool */
  const poolOf = pool => {
    const record = poolRecords.get(pool);
    if (record === undefined) throw Error(m4Texts.unknownPool);
    return record;
  };
  /** @param {PoolRecord} record */
  const assertActivePool = record => {
    if (record.state === 'retired') throw Error(m4Texts.retired);
  };

  const makeMemberExo = defineExoClass(
    'PoolMember',
    m4Interfaces.PoolMember,
    () => harden({}),
    {
      describe() {
        const record = memberOf(this.self);
        return harden({
          provider: record.provider,
          label: record.label,
          weight: record.weight,
          state: record.state,
          ...(record.declared === undefined
            ? {}
            : { declared: record.declared }),
        });
      },
      /**
       * Retire the member: out of every pool's selection; its mark and the
       * served records naming it are dropped (3.1).
       */
      async retire() {
        const member = this.self;
        const record = memberOf(member);
        if (record.state === 'retired') return undefined;
        memberRecords.set(member, harden({ ...record, state: 'retired' }));
        memberList = memberList.filter(entry => entry !== member);
        marks.delete(member);
        for (const pool of poolList) {
          const { served } = poolOf(pool);
          for (const [session, entry] of served) {
            if (entry.member === member) served.delete(session);
          }
        }
        return announcePoolsChanged();
      },
    },
  );

  /**
   * @param {{ provider: 'claude' | 'codex', label: string, credential: any, weight?: number, declared?: any }} request
   */
  const makeMember = request => {
    const { provider, label, credential, weight = 1, declared } = request;
    const secret = secretRecords.get(credential);
    if (secret === undefined) throw secretError('UNKNOWN_SECRET');
    for (const member of memberList) {
      const record = memberOf(member);
      if (record.label === label) {
        // R8-31: idempotent by label and credential; another credential
        // under the label is refused until that member is retired.
        if (record.credential === credential && record.provider === provider)
          return member;
        throw Error(m4Texts.memberConflict);
      }
    }
    if (memberList.length >= m4Limits.maxMembers)
      throw secretError('CREATE_FAILED');
    const member = makeMemberExo();
    memberSerial += 1;
    memberRecords.set(
      member,
      harden({
        provider,
        label,
        credential,
        key: secret.key,
        weight,
        state: 'active',
        serial: memberSerial,
        ...(declared === undefined ? {} : { declared }),
      }),
    );
    memberList = [...memberList, member];
    return member;
  };

  /**
   * @param {string} [cursor] the creation serial of the last member of the
   *   page before (HR-SYN-11: a retirement between pages skips none)
   */
  const listMembers = cursor => {
    const after = serialCursor(cursor, 'not a members cursor');
    const rest = memberList.filter(member => memberOf(member).serial > after);
    const members = rest.slice(0, m4Limits.poolPageEntries);
    return harden(
      rest.length > members.length
        ? {
            members,
            next: `${memberOf(members[members.length - 1]).serial}`,
          }
        : { members },
    );
  };

  /**
   * The model's catalogue row, read through the pool's `listModels`
   * forward (the ops facet answers rows with efforts; `resolveModel`'s
   * answer has none), at most `EFFORT_PAGES` pages.
   * @param {any} backend
   * @param {any} spec
   * @param {string} modelId
   */
  const rowOf = async (backend, spec, modelId) => {
    /** @type {string | undefined} */
    let after;
    for (let page = 0; page < EFFORT_PAGES; page += 1) {
      const request = harden(
        after === undefined
          ? { limit: limits.modelPageRows }
          : { limit: limits.modelPageRows, after },
      );
      // eslint-disable-next-line no-await-in-loop
      const answer = await withOps(ops =>
        E(ops).listModels(harden({ backend, spec, request })),
      );
      if (answer.state !== 'ok') throw Error(answer.error);
      const row = answer.rows.find(
        (/** @type {any} */ entry) => entry.modelId === modelId,
      );
      if (row !== undefined) return row;
      if (answer.next === undefined) break;
      after = answer.next;
    }
    throw Error(textOf.unknownProviderModel(modelId));
  };

  /**
   * A pool Backend (exo name `Backend`, `m4Interfaces.PoolBackend`).
   * @param {any} spec
   */
  const makePoolBackend = spec => {
    const info = harden(
      spec.modelId === undefined
        ? { kind: spec.kind, label: spec.label }
        : { kind: spec.kind, label: spec.label, modelId: spec.modelId },
    );
    const backend = makeExo('Backend', m4Interfaces.PoolBackend, {
      describe: () => info,
      /** @param {any} [request] a `ModelRequest` */
      listModels: async request => {
        assertActivePool(poolOf(backend));
        return withOps(ops =>
          E(ops).listModels(
            harden(
              request === undefined
                ? { backend, spec }
                : { backend, spec, request },
            ),
          ),
        );
      },
      /** @param {string} [modelId] */
      resolveModel: async modelId => {
        assertActivePool(poolOf(backend));
        // R4-21: a pool has no default model unless its spec names one.
        if (modelId === undefined && spec.modelId === undefined)
          throw Error(m4Texts.subscriptionModelRequired);
        return withOps(ops =>
          E(ops).resolveModel(
            harden(
              modelId === undefined
                ? { backend, spec }
                : { backend, spec, modelId },
            ),
          ),
        );
      },
      /**
       * R4-23: a given effort must be one the model's row offers; none
       * given answers the row's default (else none).
       * @param {{ modelId: string, reasoningEffort?: string }} request
       */
      resolveEffort: async ({ modelId, reasoningEffort }) => {
        assertActivePool(poolOf(backend));
        const row = await rowOf(backend, spec, modelId);
        if (reasoningEffort === undefined) {
          return harden(
            row.defaultReasoningEffort === undefined
              ? {}
              : { reasoningEffort: row.defaultReasoningEffort },
          );
        }
        // R4-23: the Codex catalogue lists efforts in the Responses
        // spelling, where Fae's `ultra` is `max` (the wire sends it so);
        // `ultra` is admitted wherever `max` is (W4.8).
        const listed =
          spec.kind === 'codex-pool' && reasoningEffort === 'ultra'
            ? 'max'
            : reasoningEffort;
        if (!row.reasoningEfforts.includes(listed))
          throw Error(m4Texts.unsupportedEffort);
        return harden({ reasoningEffort });
      },
      /**
       * As M2's Backend: waits for the bind, records session -> pool, and
       * forwards the open with the pool spec and the archive key.
       * @param {any} host
       */
      open: async host => {
        assertActivePool(poolOf(backend));
        const session = await whenBound(host);
        poolOfSession.set(session, backend);
        const archiveKey = archiveKeyOf(session);
        return withOps(ops =>
          E(ops).open(
            harden(
              archiveKey === null
                ? { backend, spec, session }
                : { backend, spec, session, archiveKey },
            ),
          ),
        );
      },
    });
    return backend;
  };

  /** @param {any} spec a `PoolSpec` (checked by the guard) */
  const makePool = spec => {
    if (!fitsFrame(spec)) throw Error(texts.frameLimit);
    const provider = providerOf(spec.kind);
    if (spec.members.length === 0) throw Error(m4Texts.noUsableMember);
    const seen = new Set();
    for (const member of spec.members) {
      const record = memberOf(member);
      if (record.state !== 'active') throw Error(m4Texts.noUsableMember);
      if (record.provider !== provider) throw Error(m4Texts.memberKind);
      // One attempt per member per round (R4-25): a member listed twice
      // would be tried twice.
      if (seen.has(member)) throw Error(m4Texts.poolConflict);
      seen.add(member);
    }
    for (const pool of poolList) {
      const record = poolOf(pool);
      if (record.spec.label === spec.label) {
        // R8-23, K-1: idempotent by label and spec.
        if (sameSpec(record.spec, spec)) return pool;
        throw Error(m4Texts.poolConflict);
      }
    }
    if (poolList.length >= m4Limits.maxPools) throw Error(m4Texts.poolConflict);
    const pool = makePoolBackend(spec);
    poolRecords.set(pool, { spec, state: 'active', served: new Map() });
    poolList = [...poolList, pool];
    return pool;
  };

  /** @param {any} pool */
  const retirePool = async pool => {
    const record = poolOf(pool);
    if (record.state === 'retired') return undefined;
    record.state = 'retired';
    record.served.clear();
    poolList = poolList.filter(entry => entry !== pool);
    return announcePoolsChanged();
  };

  /** @param {any} pool */
  const describePool = pool => {
    const { spec, state } = poolOf(pool);
    return harden({
      kind: spec.kind,
      label: spec.label,
      members: spec.members,
      state,
    });
  };

  const admin = makeExo('SubscriptionsAdmin', m4Interfaces.SubscriptionsAdmin, {
    makeMember,
    listMembers,
    makePool,
    listPools: () => harden({ pools: poolList }),
    describePool,
    retirePool,
    accounts: async () =>
      withCredentialOps(credentialOps => E(credentialOps).accounts()),
  });

  // ---- sink methods (the adapter only; m4SinkMethodGuards) ----

  /**
   * The pool as the adapter needs it: one crank per pool per incarnation.
   * @param {any} pool
   */
  const poolState = pool => {
    const record = poolOf(pool);
    const members = record.spec.members.map((/** @type {any} */ member) => {
      const entry = memberOf(member);
      const mark = marks.get(member);
      return harden({
        member,
        label: entry.label,
        provider: entry.provider,
        weight: entry.weight,
        key: entry.key,
        state: entry.state,
        ...(mark === undefined ? {} : { mark }),
        ...(entry.declared === undefined ? {} : { declared: entry.declared }),
      });
    });
    const served = [...record.served].map(([session, { member, at }]) =>
      harden({ session, member, at }),
    );
    return harden({ state: record.state, members, served });
  };

  /**
   * Marks at once, served stamps coalesced (5.1). Entries naming a member
   * outside this pool or retired are ignored (a late sendOnly after a
   * retire); a served record past `servedRecords` drops the least recently
   * served.
   * @param {any} pool
   * @param {{ marks?: { member: any, mark?: any }[], served?: { session: any, member: any, at: number }[] }} change
   */
  const poolChanged = (pool, change) => {
    const record = poolOf(pool);
    if (record.state === 'retired') return undefined;
    /** @param {any} member */
    const usable = member =>
      record.spec.members.includes(member) &&
      memberRecords.get(member)?.state === 'active';
    for (const { member, mark } of change.marks ?? []) {
      if (usable(member)) {
        if (mark === undefined) marks.delete(member);
        else marks.set(member, mark);
      }
    }
    const { served } = record;
    for (const { session, member, at } of change.served ?? []) {
      const kept = served.get(session);
      if (usable(member) && (kept === undefined || kept.at <= at)) {
        served.delete(session);
        served.set(session, harden({ member, at }));
        if (served.size > m4Limits.servedRecords) {
          const oldest = served.keys().next().value;
          served.delete(oldest);
        }
      }
    }
    return undefined;
  };

  // ---- Secrets, full (4.1) ----

  /**
   * One catalogue page (R7-22, R6-67): labels and descriptions from this
   * vat's records, generation, state and bytes from one `describeSecrets`
   * call; never a value (R7-26). At most `catalogPageEntries`, then cut to
   * one frame (`fitsFrame`), `next` naming the first entry left out.
   * @param {string} [cursor] the creation serial of the last Secret of the
   *   page before (HR-SYN-11: a delete between pages skips none, as
   *   `SecretsAdmin.list`, J-9486)
   */
  const catalog = async cursor => {
    const after = serialCursor(cursor, 'not a secrets cursor');
    /** A Secret's creation serial: its store key `k<n>`. @param {any} secret */
    const serialOf = secret =>
      Number(/** @type {any} */ (secretRecords.get(secret)).key.slice(1));
    const rest = secretList().filter(secret => serialOf(secret) > after);
    const secrets = rest.slice(0, m4Limits.catalogPageEntries);
    // Taken now: a delete during the describe call drops the record.
    const serials = secrets.map(serialOf);
    const recordsOf = secrets.map(secret => secretRecords.get(secret));
    const keys = harden(
      recordsOf.flatMap(record => (record === undefined ? [] : [record.key])),
    );
    const infos =
      keys.length === 0
        ? []
        : await withCredentialOps(credentialOps =>
            E(credentialOps).describeSecrets(keys),
          );
    /** @type {Map<string, any>} */
    const infoOf = new Map();
    for (const info of infos) {
      if (info !== null) infoOf.set(info.key, info);
    }
    /** @type {any[]} */
    const entries = [];
    for (let i = 0; i < secrets.length; i += 1) {
      const record = recordsOf[i];
      const info = record === undefined ? undefined : infoOf.get(record.key);
      // A secret the store does not know (deleted meanwhile) is left out.
      entries.push(
        record === undefined || info === undefined
          ? undefined
          : harden({
              secret: secrets[i],
              label: record.label,
              description: record.description,
              generation: info.generation,
              state: info.state,
              bytes: info.bytes,
            }),
      );
    }
    /** @param {number} count entries of this page taken */
    const pageOf = count => {
      const taken = entries.slice(0, count).filter(Boolean);
      return harden(
        count < rest.length
          ? { entries: taken, next: `${serials[count - 1]}` }
          : { entries: taken },
      );
    };
    let page = pageOf(entries.length);
    if (fitsFrame(page)) return page;
    // The largest prefix that fits one frame (binary search: <= 6
    // measurements for 64 entries; one entry always fits).
    let low = 1;
    let high = entries.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fitsFrame(pageOf(middle))) low = middle;
      else high = middle - 1;
    }
    page = pageOf(low);
    return page;
  };

  const secretsAdminMethods = harden({
    catalog,
    /** The adapter-local audit reader (R7-63). */
    auditReader: async () =>
      withCredentialOps(credentialOps => E(credentialOps).auditReader()),
    subscriptions: () => admin,
  });

  const secretMethods = harden({
    /**
     * R6-67, R7-23: the record here first (the system of record), then the
     * store's copy so audit labels follow (idempotent).
     * @this {{ self: any }}
     * @param {string} description
     */
    async setDescription(description) {
      assertDescription(description);
      const secret = this.self;
      const record = secretRecords.get(secret);
      if (record === undefined) throw secretError('UNKNOWN_SECRET');
      secretRecords.set(secret, harden({ ...record, description }));
      await withCredentialOps(credentialOps =>
        E(credentialOps).setSecretDescription(record.key, description),
      );
      return undefined;
    },
  });

  const sinkMethods = harden({
    poolState,
    poolChanged,
    /** @param {any} session */
    poolOf: session => poolOfSession.get(session),
  });

  return harden({ admin, secretsAdminMethods, secretMethods, sinkMethods });
};
harden(makeSubscriptionsPart);

/**
 * The sink's M4 methods, calling the part at call time: the sink is made
 * before the part (H-2), so it cannot spread `part.sinkMethods` directly.
 * @param {() => { sinkMethods: any }} getPart
 */
export const forwardSinkMethods = getPart =>
  harden({
    /** @param {any} pool */
    poolState: pool => getPart().sinkMethods.poolState(pool),
    /**
     * @param {any} pool
     * @param {any} change
     */
    poolChanged: (pool, change) =>
      getPart().sinkMethods.poolChanged(pool, change),
    /** @param {any} session */
    poolOf: session => getPart().sinkMethods.poolOf(session),
  });
harden(forwardSinkMethods);
