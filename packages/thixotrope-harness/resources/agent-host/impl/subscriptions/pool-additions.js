// @ts-check
/**
 * Pool members added in the adapter (`designs/m4-interfaces.md` 3.5): how
 * a subscription joins an existing pool on a state whose subscriptions
 * manager predates `SubscriptionsAdmin.addMember`.
 *
 * The manager installed on such a state is pinned (a same-name reinstall
 * with other code is refused), and in it a pool's members are its spec's,
 * fixed at `makePool` (`poolState` answers `spec.members`, `poolChanged`
 * ignores anyone else, and `makePool` under a taken label answers
 * `poolConflict` unless the spec is the same). This module keeps the
 * additions on the adapter's side instead, layered over the spec:
 *
 * - The manager stays the source of the objects and of retirement: an
 *   addition is a `PoolMember` the manager made (`makeMember`, from the
 *   `Secret` the operator chose), and `PoolMember.retire()` takes it out
 *   (its `describe().state`, read at each load of the pool, which the
 *   manager's `poolsChanged` push or the `poolStateRefreshMs` bound brings).
 * - The adapter keeps which pool each one joined, in
 *   `<state>/agent-host/subscriptions/pool-additions.json` (written before
 *   an add answers: temp file, fsync, rename). Format:
 *   `{ format: 'thixotrope-harness-pool-additions-1', pools: [{ kind,
 *   label, specKeys, members: [{ key, label, provider }] }] }`. A pool is
 *   found by its kind, label and the store keys of its spec members in
 *   order (a later pool under a retired one's label has other members, so
 *   it inherits nothing); `key` is the credential's store key (`k<n>`) and
 *   never leaves the adapter. No secret value, token or presence is kept.
 * - A restarted adapter has the keys but no presences. It finds each
 *   addition's objects again through the operator it serves the gateway
 *   with (`Operator.getSecrets()` -> `catalog()` for the `Secret` whose key
 *   is kept, -> `subscriptions().listMembers()` for the active members),
 *   then, for a label an active member has, asks `makeMember` with that
 *   label and the Secret: the old manager answers the existing member
 *   exactly when it holds that Secret (R8-31), so the search never makes
 *   one. A kept label no active member has was retired: the addition is
 *   dropped.
 *   Until an operator is known (before the gateway's first bind) the pool
 *   serves its spec members and asks again at its next load.
 *
 * Guarantees, as `addMember` in the manager: a format check of the Secret
 * here before anything is made (`checkCredential`, the value stays in the
 * adapter); idempotent by label and Secret (a retry answers the member it
 * made; another Secret under a label in the pool is `memberConflict`);
 * only active members count towards `maxPoolMembers`. Retained state:
 * at most `maxPools` pools of at most `maxPoolMembers` additions; a pool
 * past that drops the entries of pools no longer listed.
 *
 * What the old manager cannot keep for an addition: its refusal mark and
 * last-served records (`poolChanged` ignores a member outside the spec).
 * They live in this incarnation only; after a restart an addition costs at
 * most one more refusal and one cold choice (10, K-2).
 *
 * Node only.
 */
import { readFileSync } from 'node:fs';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
import {
  providerOfKind,
  subscriptionTextOf,
  subscriptionTexts,
} from '../../../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { writeAtomic } from './account-file.js';

/** @import { MemberEntry } from './types.js' */

export const POOL_ADDITIONS_FORMAT = 'thixotrope-harness-pool-additions-1';
const KEY_PATTERN = /^k[0-9]{1,15}$/;
/** At most this many catalogue or member pages are read to find objects. */
const MAX_PAGES = 4;

/**
 * @typedef {object} StoredMember
 * @property {string} key the credential's store key
 * @property {string} label
 * @property {'claude' | 'codex'} provider
 *
 * @typedef {object} StoredPool
 * @property {string} kind
 * @property {string} label
 * @property {string[]} specKeys the spec members' store keys, in order
 * @property {StoredMember[]} members
 *
 * @typedef {object} PoolInfo
 * @property {string} kind
 * @property {string} label
 */

/** @param {unknown} value */
const isText = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

/**
 * The additions file's pools; anything missing or malformed is none.
 * @param {string} file
 * @returns {StoredPool[]}
 */
export const loadPoolAdditions = file => {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.format !== POOL_ADDITIONS_FORMAT ||
    !Array.isArray(parsed.pools)
  )
    return [];
  /** @type {StoredPool[]} */
  const pools = [];
  for (const candidate of parsed.pools.slice(0, subscriptionLimits.maxPools)) {
    const { kind, label, specKeys, members } =
      candidate !== null && typeof candidate === 'object' ? candidate : {};
    const provider = providerOfKind[kind];
    if (
      provider !== undefined &&
      isText(label) &&
      Array.isArray(specKeys) &&
      specKeys.length <= subscriptionLimits.maxPoolMembers &&
      specKeys.every(key => typeof key === 'string' && KEY_PATTERN.test(key)) &&
      Array.isArray(members)
    ) {
      /** @type {StoredMember[]} */
      const kept = [];
      for (const member of members.slice(
        0,
        subscriptionLimits.maxPoolMembers,
      )) {
        const usable =
          member !== null &&
          typeof member === 'object' &&
          typeof member.key === 'string' &&
          KEY_PATTERN.test(member.key) &&
          isText(member.label) &&
          member.provider === provider &&
          !kept.some(
            other => other.key === member.key || other.label === member.label,
          );
        if (usable)
          kept.push({ key: member.key, label: member.label, provider });
      }
      if (kept.length > 0)
        pools.push({ kind, label, specKeys: [...specKeys], members: kept });
    }
  }
  return pools;
};
harden(loadPoolAdditions);

/** @param {readonly StoredPool[]} pools */
export const formatPoolAdditions = pools =>
  `${JSON.stringify({
    format: POOL_ADDITIONS_FORMAT,
    pools: pools.map(({ kind, label, specKeys, members }) => ({
      kind,
      label,
      specKeys,
      members: members.map(({ key, label: name, provider }) => ({
        key,
        label: name,
        provider,
      })),
    })),
  })}\n`;
harden(formatPoolAdditions);

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 */
const sameKeys = (a, b) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * @param {(cursor?: string) => Promise<any>} read
 * @param {string} field
 */
const allPages = async (read, field) => {
  /** @type {any[]} */
  const all = [];
  /** @type {string | undefined} */
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await read(cursor);
    all.push(...answer[field]);
    cursor = answer.next;
    if (cursor === undefined) break;
  }
  return all;
};

/**
 * @param {object} options
 * @param {() => string} options.file the additions file
 * @param {() => Promise<{ secrets: any, subscriptions: any } | undefined>} options.admins
 *   the `SecretsAdmin` and `SubscriptionsAdmin` reached through the
 *   operator the gateway serves, or undefined while there is none
 * @param {(secret: any) => Promise<string | null>} options.resolveSecret a
 *   `Secret` presence's store key (`sink.resolveSecrets`, cached)
 * @param {(secret: any, provider: 'claude' | 'codex') => Promise<{ ok: boolean, code?: string }>} options.checkCredential
 *   the format check (`CredentialOps.checkCredential`)
 * @param {() => Promise<(PoolInfo & { specKeys: string[] })[]>} [options.livePools]
 *   the manager's active pools (only to drop entries past `maxPools`)
 * @param {(error: unknown) => void} [options.onError]
 */
export const makePoolAdditions = ({
  file,
  admins,
  resolveSecret,
  checkCredential,
  livePools = async () => [],
  onError = () => {},
}) => {
  /** @type {StoredPool[] | undefined} */
  let stored;
  const poolsNow = () => {
    stored ??= loadPoolAdditions(file());
    return stored;
  };
  /** Bumped whenever what a pool serves may have changed. */
  let rev = 0;
  /**
   * This incarnation's presence of each kept addition, by store key.
   * @type {Map<string, any>}
   */
  const presences = new Map();
  /**
   * Keys whose objects were not found in this incarnation (a deleted
   * Secret, a label taken by another credential): not asked again.
   * @type {Set<string>}
   */
  const missing = new Set();
  /** The last `describe()` of each addition (a failed one keeps it). */
  /** @type {WeakMap<any, any>} */
  const infos = new WeakMap();
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} body
   * @returns {Promise<T>}
   */
  const serialize = body => {
    const run = chain.then(body);
    chain = run.catch(() => {});
    return run;
  };

  /** @param {StoredPool[]} next */
  const save = async next => {
    await writeAtomic(file(), formatPoolAdditions(next));
    stored = next;
    rev += 1;
  };

  /**
   * @param {PoolInfo} info
   * @param {readonly string[]} specKeys
   */
  const entryOf = (info, specKeys) =>
    poolsNow().find(
      pool =>
        pool.kind === info.kind &&
        pool.label === info.label &&
        sameKeys(pool.specKeys, specKeys),
    );

  /**
   * Drop kept additions (retired, or found to be another member). Queued
   * behind any add in progress, never awaited by one (an add's own load
   * may find a retirement).
   * @param {PoolInfo} info
   * @param {readonly string[]} specKeys
   * @param {(member: StoredMember) => boolean} drop
   */
  const dropWhere = (info, specKeys, drop) => {
    const dropped = serialize(async () => {
      const pool = entryOf(info, specKeys);
      if (pool === undefined || !pool.members.some(drop)) return;
      const members = pool.members.filter(member => !drop(member));
      /** @type {StoredPool[]} */
      const next = [];
      for (const entry of poolsNow()) {
        if (entry !== pool) next.push(entry);
        else if (members.length > 0) next.push({ ...entry, members });
      }
      await save(next);
    });
    dropped.catch(onError);
    return dropped;
  };

  /** In flight: the search for the objects of kept additions. */
  /** @type {Promise<boolean> | undefined} */
  let finding;

  /**
   * Find this incarnation's presences of kept additions (one search at a
   * time). Answers whether an operator was reachable.
   * @param {PoolInfo} info
   * @param {readonly string[]} specKeys
   * @param {readonly StoredMember[]} wanted
   */
  const find = (info, specKeys, wanted) => {
    finding ??= (async () => {
      const reached = await admins().catch(() => undefined);
      if (reached === undefined) return false;
      const { secrets, subscriptions } = reached;
      const listed = new Set(
        await allPages(
          cursor =>
            cursor === undefined
              ? E(subscriptions).listMembers()
              : E(subscriptions).listMembers(cursor),
          'members',
        ),
      );
      const keys = new Set(wanted.map(member => member.key));
      /** @type {Map<string, any>} */
      const secretOf = new Map();
      const entries = await allPages(
        cursor =>
          cursor === undefined
            ? E(secrets).catalog()
            : E(secrets).catalog(cursor),
        'entries',
      );
      await Promise.all(
        entries.map(async entry => {
          const key = await resolveSecret(entry.secret).catch(() => null);
          if (key !== null && keys.has(key)) secretOf.set(key, entry.secret);
        }),
      );
      // The active members' labels: `listMembers` lists active ones only,
      // and `makeMember` is asked only for a label listed there, so a
      // search never makes a member.
      const described = await Promise.all(
        [...listed].map(async member => ({
          member,
          info: await E(member)
            .describe()
            .catch(() => undefined),
        })),
      );
      /** @type {StoredMember[]} */
      const gone = [];
      for (const want of wanted) {
        const secret = secretOf.get(want.key);
        const active = described.find(
          ({ info: seen }) =>
            seen?.state === 'active' &&
            seen.label === want.label &&
            seen.provider === want.provider,
        );
        if (active === undefined) {
          // Retired (it leaves the manager's list): the addition ends.
          gone.push(want);
        } else if (secret === undefined) {
          missing.add(want.key);
        } else {
          // Answers the listed member exactly when it holds this Secret
          // (R8-31); another credential under the label is a conflict.
          // eslint-disable-next-line no-await-in-loop
          const member = await E(subscriptions)
            .makeMember(
              harden({
                provider: want.provider,
                label: want.label,
                credential: secret,
              }),
            )
            .catch(() => undefined);
          if (member === active.member) presences.set(want.key, member);
          else missing.add(want.key);
        }
      }
      if (gone.length > 0)
        void dropWhere(info, specKeys, member => gone.includes(member)).catch(
          () => {},
        );
      rev += 1;
      return true;
    })().finally(() => {
      finding = undefined;
    });
    return finding;
  };

  /**
   * The additions a pool serves now, active only, and whether some still
   * wait for an operator to be found.
   * @param {PoolInfo} info
   * @param {readonly MemberEntry[]} specMembers the manager's `poolState`
   * @returns {Promise<{ members: MemberEntry[], pending: boolean }>}
   */
  const extrasOf = async (info, specMembers) => {
    const specKeys = specMembers.map(entry => entry.key);
    const pool = entryOf(info, specKeys);
    if (pool === undefined) return { members: [], pending: false };
    let pending = false;
    const unknown = pool.members.filter(
      member => !presences.has(member.key) && !missing.has(member.key),
    );
    if (unknown.length > 0) pending = !(await find(info, specKeys, unknown));
    const inSpec = new Set(specMembers.map(entry => entry.member));
    const found = (entryOf(info, specKeys)?.members ?? []).flatMap(member => {
      const presence = presences.get(member.key);
      return presence === undefined || inSpec.has(presence)
        ? []
        : [{ stored: member, presence }];
    });
    const described = await Promise.all(
      found.map(async ({ stored: member, presence }) => {
        const answer = await E(presence)
          .describe()
          .catch(() => undefined);
        if (answer !== undefined) infos.set(presence, answer);
        return { member, presence, describedAs: infos.get(presence) };
      }),
    );
    const retired = described.filter(
      ({ describedAs }) => describedAs?.state === 'retired',
    );
    if (retired.length > 0) {
      for (const { member } of retired) presences.delete(member.key);
      const gone = new Set(retired.map(({ member }) => member.key));
      void dropWhere(info, specKeys, member => gone.has(member.key)).catch(
        () => {},
      );
    }
    /** @type {MemberEntry[]} */
    const members = described
      .filter(({ describedAs }) => describedAs?.state !== 'retired')
      .map(({ member, presence, describedAs }) =>
        harden({
          member: presence,
          label: member.label,
          provider: member.provider,
          weight: describedAs?.weight ?? 1,
          key: member.key,
          state: 'active',
          ...(describedAs?.declared === undefined
            ? {}
            : { declared: describedAs.declared }),
        }),
      );
    return { members, pending };
  };

  /**
   * Make room for one more pool: drop the entries of pools no longer
   * listed (retired while this adapter was away).
   * @param {StoredPool[]} pools
   */
  const roomFor = async pools => {
    if (pools.length < subscriptionLimits.maxPools) return pools;
    const live = await livePools();
    const kept = pools.filter(pool =>
      live.some(
        other =>
          other.kind === pool.kind &&
          other.label === pool.label &&
          sameKeys(other.specKeys, pool.specKeys),
      ),
    );
    if (kept.length >= subscriptionLimits.maxPools)
      throw Error(subscriptionTexts.poolConflict);
    return kept;
  };

  /**
   * Add a subscription to a pool: the pool rules, the format check, then
   * the manager's `makeMember` and the kept addition. Idempotent.
   * @param {PoolInfo} info the pool's `describe()`
   * @param {readonly MemberEntry[]} specMembers its `poolState().members`
   * @param {{ label: string, credential: any, weight?: number, declared?: any }} request
   */
  const add = (info, specMembers, request) =>
    serialize(async () => {
      const provider = providerOfKind[info.kind];
      if (provider === undefined) throw Error(subscriptionTexts.memberKind);
      const { label, credential } = request;
      const key = await resolveSecret(credential);
      if (key === null)
        throw Error(subscriptionTextOf.credentialCheckFailed('UNKNOWN_SECRET'));
      const plan = async () => {
        const { members: extras } = await extrasOf(info, specMembers);
        const active = [
          ...specMembers.filter(entry => entry.state === 'active'),
          ...extras,
        ];
        const same = active.find(entry => entry.label === label);
        if (same !== undefined) {
          if (same.key !== key || same.provider !== provider)
            throw Error(subscriptionTexts.memberConflict);
          return same.member;
        }
        // One credential serves a pool once (else it counts twice).
        if (active.some(entry => entry.key === key))
          throw Error(subscriptionTexts.memberConflict);
        if (active.length >= subscriptionLimits.maxPoolMembers)
          throw Error(subscriptionTexts.poolFull);
        return undefined;
      };
      const done = await plan();
      if (done !== undefined) return done;
      const check = await checkCredential(credential, provider);
      if (!check.ok)
        throw Error(
          subscriptionTextOf.credentialCheckFailed(check.code ?? 'READ_FAILED'),
        );
      const reached = await admins();
      if (reached === undefined)
        throw Error(subscriptionTexts.additionsUnreachable);
      const member = await E(reached.subscriptions).makeMember(
        harden({
          provider,
          label,
          credential,
          ...(request.weight === undefined ? {} : { weight: request.weight }),
          ...(request.declared === undefined
            ? {}
            : { declared: request.declared }),
        }),
      );
      const specKeys = specMembers.map(entry => entry.key);
      const pool = entryOf(info, specKeys);
      const addition = { key, label, provider };
      const pools = pool
        ? poolsNow().map(entry =>
            entry === pool
              ? {
                  ...entry,
                  members: [
                    ...entry.members.filter(
                      kept => kept.key !== key && kept.label !== label,
                    ),
                    addition,
                  ],
                }
              : entry,
          )
        : [
            ...(await roomFor(poolsNow())),
            {
              kind: info.kind,
              label: info.label,
              specKeys: [...specKeys],
              members: [addition],
            },
          ];
      presences.set(key, member);
      missing.delete(key);
      await save(pools);
      return member;
    });

  return harden({
    rev: () => rev,
    extrasOf,
    add,
    /**
     * A pool the manager retired: its additions are forgotten.
     * @param {PoolInfo} info
     * @param {readonly MemberEntry[]} specMembers
     */
    poolRetired: (info, specMembers) => {
      void dropWhere(
        info,
        specMembers.map(entry => entry.key),
        () => true,
      ).catch(() => {});
    },
    /** Wait for every queued add and drop (tests, shutdown). */
    settled: () => chain,
    /** Whether any addition is kept (tests). */
    kept: () => poolsNow().map(pool => harden({ ...pool })),
  });
};
harden(makePoolAdditions);
