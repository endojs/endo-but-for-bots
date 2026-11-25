// @ts-check
/**
 * Pool members added in the adapter (`designs/m4-interfaces.md` 3.5): how
 * a subscription joins an existing pool on a state whose subscriptions
 * manager predates `SubscriptionsAdmin.addMember`, whose pools serve their
 * spec members only (`poolState` answers `spec.members`, `poolChanged`
 * ignores anyone else).
 *
 * - The manager stays the source of the objects and of retirement: an
 *   addition is a `PoolMember` the manager made (`makeMember`) from the
 *   `Secret` the operator chose; `PoolMember.retire()` ends it.
 * - The adapter keeps which pool each one joined in
 *   `<state>/agent-host/subscriptions/pool-additions.json` (temp, fsync,
 *   rename, directory fsync; `account-file.js` `writeAtomic`), written only
 *   by the process holding `pool-additions.lock` (exclusive create; a stale
 *   lock of a dead process is taken over). Format
 *   `thixotrope-harness-pool-additions-2` (`-1` is read and completed):
 *   `{ pools: [{ kind, label, specKeys, specSerials?, members: [{ key,
 *   label, provider, serial?, mark? }] }] }`. `key` is the credential's
 *   store key (never reused), `serial` the member's creation serial as the
 *   manager's `listMembers` cursor reports it (never reused), `specSerials`
 *   those of the pool's spec members (null for one already retired),
 *   `mark` the adapter's refusal mark. No value, token or presence.
 * - A file that cannot be parsed is moved aside under a dated name, never
 *   rewritten; adding is refused while it is unreadable (this incarnation).
 * - A restarted adapter finds the objects again through the manager's
 *   admin objects (`reconcile`): the pool by label, confirmed by its spec
 *   members' keys and serials; the Secret by key in the catalogue; the
 *   member by `makeMember(label, Secret)` asked only for a label an active
 *   member has (so it never makes one), confirmed by identity and serial.
 *   An entry is dropped only on a definite answer from complete lists
 *   (pool no longer listed or remade, Secret gone, member retired, label
 *   taken by another credential, member remade). Any failed read leaves it
 *   pending with a code (`notesOf`), asked again after `ADDITIONS_RETRY_MS`.
 * - On a manager that has `addPoolMember` the restored additions are moved
 *   into the manager's pool once (`MIGRATED`) and their entries dropped.
 *
 * Node only.
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

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

/** @import { MemberEntry, Mark } from './types.js' */

export const POOL_ADDITIONS_FORMAT = 'thixotrope-harness-pool-additions-2';
const READ_FORMATS = [
  POOL_ADDITIONS_FORMAT,
  'thixotrope-harness-pool-additions-1',
];
/** A pending restore, an unreadable file: asked again after this. */
export const ADDITIONS_RETRY_MS = 5000;
const KEY_PATTERN = /^k[0-9]{1,15}$/;
/** Catalogue pages read to find Secrets (1,024 Secrets / 64 per page). */
const MAX_CATALOG_PAGES = 16;
/** Member pages (`maxMembers` 64 / `poolPageEntries` 64, one to spare). */
const MAX_MEMBER_PAGES = 2;

/**
 * @typedef {object} StoredMember
 * @property {string} key the credential's store key
 * @property {string} label
 * @property {'claude' | 'codex'} provider
 * @property {number} [serial] the member's creation serial
 * @property {Mark} [mark]
 *
 * @typedef {object} StoredPool
 * @property {string} kind
 * @property {string} label
 * @property {string[]} specKeys the spec members' store keys, in order
 * @property {(number | null)[]} [specSerials]
 * @property {StoredMember[]} members
 *
 * @typedef {object} PoolInfo
 * @property {string} kind
 * @property {string} label
 *
 * @typedef {{ pools: StoredPool[] } | { problem: 'CORRUPT' | 'IO' }} LoadedAdditions
 */

/** @param {unknown} value */
const isText = value =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
/** @param {unknown} value */
const isSerial = value =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
/** @param {unknown} value */
const isTime = value => typeof value === 'number' && Number.isFinite(value);

/**
 * @param {any} mark
 * @returns {Mark | undefined}
 */
const markOf = mark =>
  mark !== null &&
  typeof mark === 'object' &&
  isTime(mark.untilMs) &&
  isTime(mark.sinceMs) &&
  (mark.strikes === 0 || isSerial(mark.strikes)) &&
  typeof mark.dated === 'boolean'
    ? {
        untilMs: mark.untilMs,
        strikes: mark.strikes,
        sinceMs: mark.sinceMs,
        dated: mark.dated,
      }
    : undefined;

/**
 * One kept member, or undefined when anything about it is malformed.
 * @param {any} member
 * @param {string} provider
 * @returns {StoredMember | undefined}
 */
const memberOf = (member, provider) => {
  if (
    member === null ||
    typeof member !== 'object' ||
    typeof member.key !== 'string' ||
    !KEY_PATTERN.test(member.key) ||
    !isText(member.label) ||
    member.provider !== provider ||
    (member.serial !== undefined && !isSerial(member.serial))
  )
    return undefined;
  const mark = member.mark === undefined ? undefined : markOf(member.mark);
  if (member.mark !== undefined && mark === undefined) return undefined;
  return {
    key: member.key,
    label: member.label,
    provider: /** @type {'claude' | 'codex'} */ (provider),
    ...(member.serial === undefined ? {} : { serial: member.serial }),
    ...(mark === undefined ? {} : { mark }),
  };
};

/**
 * The additions file's text, checked whole: anything malformed (a bad
 * entry, a duplicate, past a bound) is `CORRUPT`, never a partial read
 * that a later write would make permanent.
 * @param {string} text
 * @returns {LoadedAdditions}
 */
export const parsePoolAdditions = text => {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: 'CORRUPT' };
  }
  const corrupt = /** @type {const} */ ({ problem: 'CORRUPT' });
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !READ_FORMATS.includes(parsed.format) ||
    !Array.isArray(parsed.pools) ||
    /** @type {any[]} */ (parsed.pools).length > subscriptionLimits.maxPools
  )
    return corrupt;
  /** @type {StoredPool[]} */
  const pools = [];
  for (const candidate of parsed.pools) {
    const { kind, label, specKeys, specSerials, members } =
      candidate !== null && typeof candidate === 'object' ? candidate : {};
    const provider = /** @type {Record<string, string>} */ (providerOfKind)[
      kind
    ];
    const fine =
      provider !== undefined &&
      isText(label) &&
      Array.isArray(specKeys) &&
      specKeys.length <= subscriptionLimits.maxPoolMembers &&
      specKeys.every(key => typeof key === 'string' && KEY_PATTERN.test(key)) &&
      (specSerials === undefined ||
        (Array.isArray(specSerials) &&
          specSerials.length === specKeys.length &&
          specSerials.every(serial => serial === null || isSerial(serial)))) &&
      Array.isArray(members) &&
      members.length > 0 &&
      members.length <= subscriptionLimits.maxPoolMembers &&
      !pools.some(other => other.kind === kind && other.label === label);
    if (!fine) return corrupt;
    /** @type {StoredMember[]} */
    const kept = [];
    for (const member of members) {
      const usable = memberOf(member, provider);
      if (
        usable === undefined ||
        kept.some(o => o.key === usable.key || o.label === usable.label)
      )
        return corrupt;
      kept.push(usable);
    }
    pools.push({
      kind,
      label,
      specKeys: [...specKeys],
      ...(specSerials === undefined ? {} : { specSerials: [...specSerials] }),
      members: kept,
    });
  }
  return { pools };
};
harden(parsePoolAdditions);

/**
 * The additions file: none is no additions; unreadable (`IO`, asked again
 * later) and unparsable (`CORRUPT`) are told apart.
 * @param {string} file
 * @returns {LoadedAdditions}
 */
export const loadPoolAdditions = file => {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'ENOENT'
      ? { pools: [] }
      : { problem: 'IO' };
  }
  return parsePoolAdditions(text);
};
harden(loadPoolAdditions);

/** @param {readonly StoredPool[]} pools */
export const formatPoolAdditions = pools =>
  `${JSON.stringify({
    format: POOL_ADDITIONS_FORMAT,
    pools: pools.map(({ kind, label, specKeys, specSerials, members }) => ({
      kind,
      label,
      specKeys,
      ...(specSerials === undefined ? {} : { specSerials }),
      members: members.map(({ key, label: name, provider, serial, mark }) => ({
        key,
        label: name,
        provider,
        ...(serial === undefined ? {} : { serial }),
        ...(mark === undefined ? {} : { mark }),
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
 * Every page of a manager list, and whether the list was read to its end.
 * @param {(cursor?: string) => Promise<any>} read
 * @param {string} field
 * @param {number} maxPages
 */
const allPages = async (read, field, maxPages) => {
  /** @type {any[]} */
  const all = [];
  /** @type {string | undefined} */
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await read(cursor);
    all.push(...answer[field]);
    cursor = answer.next;
    if (cursor === undefined) return { all, complete: true };
  }
  return { all, complete: false };
};

/**
 * The active members whose creation serial is above `after`, read whole
 * (`listMembers`' cursor is that serial, HR-SYN-11).
 * @param {any} subscriptions
 * @param {number} [after]
 */
const membersAfter = async (subscriptions, after) => {
  const { all, complete } = await allPages(
    cursor =>
      cursor === undefined
        ? after === undefined
          ? E(subscriptions).listMembers()
          : E(subscriptions).listMembers(`${after}`)
        : E(subscriptions).listMembers(cursor),
    'members',
    MAX_MEMBER_PAGES,
  );
  if (!complete) throw Error('member list incomplete');
  return all;
};

/**
 * An active member's creation serial, as the manager's `listMembers`
 * cursor reports it (the smallest `after` that leaves it out), or
 * undefined for a member not listed (retired). About 2 log2(serial) calls.
 * @param {any} subscriptions
 * @param {any} member
 */
export const serialOfMember = async (subscriptions, member) => {
  /** @param {number} after */
  const listedAfter = async after =>
    (await membersAfter(subscriptions, after)).includes(member);
  if (!(await listedAfter(0))) return undefined;
  let low = 0;
  let high = subscriptionLimits.maxMembers;
  // eslint-disable-next-line no-await-in-loop
  while (await listedAfter(high)) {
    low = high;
    high *= 2;
    if (high > Number.MAX_SAFE_INTEGER / 4) throw Error('serial unbounded');
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    // eslint-disable-next-line no-await-in-loop
    if (await listedAfter(middle)) low = middle;
    else high = middle;
  }
  return high;
};
harden(serialOfMember);

/**
 * Whether an active member has this creation serial (two calls).
 * @param {any} subscriptions
 * @param {any} member
 * @param {number} serial
 */
const hasSerial = async (subscriptions, member, serial) => {
  const [before, at] = await Promise.all([
    membersAfter(subscriptions, serial - 1),
    membersAfter(subscriptions, serial),
  ]);
  return before.includes(member) && !at.includes(member);
};

/** This process's held additions locks (incarnations share a pid in tests). */
/** @type {Set<string>} */
const heldLocks = new Set();
let incarnations = 0;

/**
 * Whether the process named in a lock file still runs.
 * @param {string} text the lock file: `<pid> <owner>`
 */
const holderAlive = text => {
  const pidOf = Number(text.split(' ')[0]);
  if (!Number.isSafeInteger(pidOf) || pidOf <= 0) return false;
  if (pidOf === process.pid) return heldLocks.has(text);
  try {
    process.kill(pidOf, 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error)?.code === 'EPERM';
  }
};

/**
 * @typedef {object} AdditionsNote what the page shows on a pool
 * @property {string} code `FILE_CORRUPT`, `FILE_UNREADABLE`, or why a kept
 *   addition is not restored yet (`UNREACHABLE`, `LIST_FAILED`,
 *   `DESCRIBE_FAILED`, `CATALOG_FAILED`, `RESOLVE_FAILED`, `MAKE_FAILED`,
 *   `MIGRATE_FAILED`)
 * @property {number} [unrestored] additions not served for that reason
 */

/**
 * @param {object} options
 * @param {() => string} options.file the additions file
 * @param {() => Promise<{ secrets: any, subscriptions: any } | undefined>} options.admins
 *   the manager's `SecretsAdmin` and `SubscriptionsAdmin` (through the
 *   gateway's `getSecrets()`), or undefined while there is none
 * @param {(secret: any) => Promise<string | null>} options.resolveSecret a
 *   `Secret` presence's store key (`sink.resolveSecrets`, cached)
 * @param {(secret: any, provider: 'claude' | 'codex') => Promise<{ ok: boolean, code?: string }>} options.checkCredential
 *   the format check (`CredentialOps.checkCredential`)
 * @param {() => Promise<(PoolInfo & { specKeys: string[] })[]>} [options.livePools]
 *   the manager's active pools, every one (a throw: not known now)
 * @param {() => number} [options.now]
 * @param {(error: unknown) => void} [options.onError]
 * @param {() => void} [options.onMigrated] some additions moved into the
 *   manager's pool (H): its `poolState` is to be read again
 */
export const makePoolAdditions = ({
  file,
  admins,
  resolveSecret,
  checkCredential,
  livePools = async () => {
    throw Error('no pool list');
  },
  now = () => Date.now(),
  onError = () => {},
  onMigrated = () => {},
}) => {
  incarnations += 1;
  const owner = `${process.pid} ${now()}-${incarnations}`;
  const lockFile = () => `${file()}.lock`;
  let lockHeld = false;
  let closed = false;
  /** @type {StoredPool[] | undefined} */
  let stored;
  /** @type {{ code: 'FILE_CORRUPT' | 'FILE_UNREADABLE', at: number } | undefined} */
  let fileProblem;
  /** Bumped whenever what a pool serves may have changed. */
  let rev = 0;
  /**
   * This incarnation's presence of each restored addition, by store key.
   * @type {Map<string, any>}
   */
  const presences = new Map();
  /**
   * Why a kept addition is not restored yet (a transient failure; asked
   * again after `ADDITIONS_RETRY_MS`), by store key.
   * @type {Map<string, string>}
   */
  const pendingCodes = new Map();
  /** Restored additions the manager's `addPoolMember` refused, by key. */
  /** @type {Map<string, string>} */
  const migrateCodes = new Map();
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

  /**
   * Take the writer's lock (exclusive create; a dead holder's is taken
   * over). Taking it reads the file again: another process may have
   * written it until now.
   */
  const acquire = async () => {
    if (lockHeld) return true;
    if (closed) return false;
    await mkdir(dirname(lockFile()), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const handle = await open(lockFile(), 'wx', 0o600);
        try {
          // eslint-disable-next-line no-await-in-loop
          await handle.writeFile(owner, 'utf8');
          // eslint-disable-next-line no-await-in-loop
          await handle.sync();
        } finally {
          // eslint-disable-next-line no-await-in-loop
          await handle.close();
        }
        lockHeld = true;
        heldLocks.add(owner);
        // A clean exit lets it go; a crash leaves a dead pid, taken over.
        process.once('exit', release);
        if (fileProblem?.code !== 'FILE_CORRUPT') stored = undefined;
        rev += 1;
        return true;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      const holder = await readFile(lockFile(), 'utf8').catch(() => '');
      if (holderAlive(holder)) return false;
      // eslint-disable-next-line no-await-in-loop
      await rm(lockFile(), { force: true });
    }
    return false;
  };

  /** Let the lock go (only ours). */
  function release() {
    if (!lockHeld) return;
    lockHeld = false;
    heldLocks.delete(owner);
    process.removeListener('exit', release);
    try {
      if (readFileSync(lockFile(), 'utf8') === owner) unlinkSync(lockFile());
    } catch {
      // Gone already.
    }
  }

  /**
   * Move an unparsable file aside under a dated name (a hard link, so an
   * existing name is never replaced), then let the file go. Under the lock.
   */
  const moveAside = async () => {
    if (!(await acquire())) return;
    const dated = new Date(now()).toISOString().replace(/[:.]/g, '-');
    for (let suffix = 0; suffix < 8; suffix += 1) {
      const aside = `${file()}.${dated}${suffix === 0 ? '' : `-${suffix}`}.unreadable`;
      try {
        // eslint-disable-next-line no-await-in-loop
        await link(file(), aside);
        // eslint-disable-next-line no-await-in-loop
        await rm(file(), { force: true });
        return;
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
      }
    }
  };

  /**
   * The kept additions. An unreadable file keeps none for now and is read
   * again after `ADDITIONS_RETRY_MS`; an unparsable one is reported, moved
   * aside and keeps none for this incarnation; either refuses adds.
   * @returns {StoredPool[]}
   */
  const poolsNow = () => {
    if (stored !== undefined) return stored;
    if (
      fileProblem !== undefined &&
      (fileProblem.code === 'FILE_CORRUPT' ||
        now() - fileProblem.at < ADDITIONS_RETRY_MS)
    )
      return [];
    const loaded = loadPoolAdditions(file());
    if ('problem' in loaded) {
      const code =
        loaded.problem === 'CORRUPT' ? 'FILE_CORRUPT' : 'FILE_UNREADABLE';
      if (fileProblem?.code !== code)
        onError(Error(`pool additions: ${file()} ${code}`));
      fileProblem = { code, at: now() };
      rev += 1;
      if (code === 'FILE_CORRUPT') {
        const moving = writing.then(moveAside);
        writing = moving.catch(onError);
      }
      return [];
    }
    if (fileProblem !== undefined) rev += 1;
    fileProblem = undefined;
    stored = loaded.pools;
    return stored;
  };

  /** File writes, one at a time (adds queue on `chain`, apart from this). */
  /** @type {Promise<unknown>} */
  let writing = Promise.resolve();

  /**
   * Change the kept additions under the lock, from the file as it is then
   * (temp, fsync, rename, directory fsync). Never while the file is
   * unreadable (it is never overwritten) or another process holds the
   * lock: `strict` throws that refusal, else nothing changes (the next
   * change tries again).
   * @param {(pools: StoredPool[]) => StoredPool[] | undefined} change
   * @param {boolean} [strict]
   */
  const write = (change, strict = false) => {
    const run = writing.then(async () => {
      poolsNow();
      if (fileProblem !== undefined) {
        if (strict) throw Error(subscriptionTexts.additionsUnreadable);
        return;
      }
      if (!(await acquire())) {
        if (strict) throw Error(subscriptionTexts.additionsLocked);
        return;
      }
      const before = poolsNow();
      const next = change(before);
      if (next === undefined || next === before) return;
      await writeAtomic(file(), formatPoolAdditions(next));
      stored = next;
      rev += 1;
    });
    writing = run.catch(() => {});
    return run;
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
   * `write`, a failure reported (drops, marks, serials).
   * @param {(pools: StoredPool[]) => StoredPool[] | undefined} change
   */
  const update = change => write(change).catch(onError);

  /**
   * Drop kept additions of one pool (a definite answer: retired, gone,
   * remade, migrated).
   * @param {PoolInfo} info
   * @param {readonly string[]} specKeys
   * @param {(member: StoredMember) => boolean} drop
   */
  const dropWhere = (info, specKeys, drop) =>
    update(pools => {
      const pool = pools.find(
        entry =>
          entry.kind === info.kind &&
          entry.label === info.label &&
          sameKeys(entry.specKeys, specKeys),
      );
      if (pool === undefined || !pool.members.some(drop)) return undefined;
      for (const member of pool.members)
        if (drop(member)) {
          presences.delete(member.key);
          pendingCodes.delete(member.key);
          migrateCodes.delete(member.key);
        }
      const members = pool.members.filter(member => !drop(member));
      return pools.flatMap(entry =>
        entry !== pool
          ? [entry]
          : members.length > 0
            ? [{ ...entry, members }]
            : [],
      );
    });

  /**
   * Mark kept additions pending with a code (reported when it changes).
   * @param {readonly StoredMember[]} members
   * @param {string} code
   */
  const pend = (members, code) => {
    const fresh = members.filter(
      member => pendingCodes.get(member.key) !== code,
    );
    for (const member of members) pendingCodes.set(member.key, code);
    if (fresh.length > 0)
      onError(
        Error(
          `pool additions: ${fresh.length} added subscription(s) could not be restored: ${code}`,
        ),
      );
  };

  /**
   * Drop the entries of pools the manager no longer lists (from its whole
   * list only; a failed read keeps them).
   */
  const dropUnlisted = async () => {
    const live = await livePools().catch(() => undefined);
    if (live === undefined) return;
    await update(pools => {
      const kept = pools.filter(pool =>
        live.some(
          other =>
            other.kind === pool.kind &&
            other.label === pool.label &&
            sameKeys(other.specKeys, pool.specKeys),
        ),
      );
      return kept.length === pools.length ? undefined : kept;
    });
  };

  /** In flight: the search for the objects of a pool's kept additions. */
  /** @type {Map<string, Promise<void>>} */
  const findings = new Map();

  /**
   * Find this incarnation's presences of a pool's kept additions (one
   * search at a time). An entry is dropped only on a definite answer from
   * complete reads; any failed read leaves it pending with a code.
   * @param {PoolInfo} info
   * @param {readonly MemberEntry[]} specMembers
   * @param {readonly StoredMember[]} wanted
   */
  const find = (info, specMembers, wanted) => {
    const id = `${info.kind}\n${info.label}`;
    const known = findings.get(id);
    if (known !== undefined) return known;
    const finding = (async () => {
      const specKeys = specMembers.map(entry => entry.key);
      const reached = await admins().catch(() => undefined);
      if (reached === undefined) return pend(wanted, 'UNREACHABLE');
      const { secrets, subscriptions } = reached;
      await dropUnlisted();
      const pool = entryOf(info, specKeys);
      if (pool === undefined) return undefined;
      /** @type {any[]} */
      let listed;
      try {
        listed = await membersAfter(subscriptions);
      } catch {
        return pend(wanted, 'LIST_FAILED');
      }
      // Pool identity: its spec members are the members it was made with
      // (creation serials, never reused); a pool remade under the label
      // over remade members is another pool.
      const { specSerials } = pool;
      if (specSerials !== undefined) {
        /** @type {boolean[]} */
        let same;
        try {
          same = await Promise.all(
            specMembers.map((entry, index) =>
              entry.state !== 'active' || specSerials[index] === null
                ? true
                : hasSerial(subscriptions, entry.member, specSerials[index]),
            ),
          );
        } catch {
          return pend(wanted, 'LIST_FAILED');
        }
        if (same.includes(false)) {
          await dropWhere(info, specKeys, () => true);
          return undefined;
        }
      }
      /** @type {Map<string, any>} */
      const secretOf = new Map();
      let catalogComplete = false;
      let resolveFailed = false;
      try {
        const keys = new Set(wanted.map(member => member.key));
        const { all, complete } = await allPages(
          cursor =>
            cursor === undefined
              ? E(secrets).catalog()
              : E(secrets).catalog(cursor),
          'entries',
          MAX_CATALOG_PAGES,
        );
        catalogComplete = complete;
        await Promise.all(
          all.map(async entry => {
            const key = await resolveSecret(entry.secret).catch(() => {
              resolveFailed = true;
              return null;
            });
            if (key !== null && keys.has(key)) secretOf.set(key, entry.secret);
          }),
        );
      } catch {
        catalogComplete = false;
      }
      // The active members' labels: `listMembers` lists active ones only,
      // and `makeMember` is asked only for a label listed there, so a
      // search never makes a member.
      let describeFailed = false;
      const described = await Promise.all(
        listed.map(async member => ({
          member,
          info: await E(member)
            .describe()
            .catch(() => {
              describeFailed = true;
              return undefined;
            }),
        })),
      );
      /** @type {Set<string>} */
      const gone = new Set();
      /** @type {Map<string, number>} */
      const serials = new Map();
      for (const want of wanted) {
        const active = described.find(
          ({ info: seen }) =>
            seen?.state === 'active' && seen.label === want.label,
        );
        const secret = secretOf.get(want.key);
        if (active === undefined) {
          // Not among the active members of a complete list: retired.
          if (describeFailed) pend([want], 'DESCRIBE_FAILED');
          else gone.add(want.key);
        } else if (active.info.provider !== want.provider) {
          gone.add(want.key);
        } else if (secret === undefined) {
          // No Secret of this key in the whole catalogue: deleted.
          if (!catalogComplete) pend([want], 'CATALOG_FAILED');
          else if (resolveFailed) pend([want], 'RESOLVE_FAILED');
          else gone.add(want.key);
        } else {
          // Answers the listed member exactly when it holds this Secret
          // (R8-31); another credential under the label is a conflict.
          /** @type {any} */
          let member;
          try {
            // eslint-disable-next-line no-await-in-loop
            member = await E(subscriptions).makeMember(
              harden({
                provider: want.provider,
                label: want.label,
                credential: secret,
              }),
            );
          } catch (error) {
            if (
              /** @type {any} */ (error)?.message ===
              subscriptionTexts.memberConflict
            )
              gone.add(want.key);
            else pend([want], 'MAKE_FAILED');
          }
          if (member !== undefined && member !== active.member) {
            pend([want], 'MAKE_FAILED');
          } else if (member !== undefined) {
            // The member it joined, not one remade under the label and
            // Secret while this adapter was away.
            try {
              if (want.serial === undefined) {
                // eslint-disable-next-line no-await-in-loop
                const serial = await serialOfMember(subscriptions, member);
                if (serial !== undefined) serials.set(want.key, serial);
                presences.set(want.key, member);
                pendingCodes.delete(want.key);
                // eslint-disable-next-line no-await-in-loop
              } else if (await hasSerial(subscriptions, member, want.serial)) {
                presences.set(want.key, member);
                pendingCodes.delete(want.key);
              } else {
                gone.add(want.key);
              }
            } catch {
              pend([want], 'LIST_FAILED');
            }
          }
        }
      }
      if (gone.size > 0)
        await dropWhere(info, specKeys, member => gone.has(member.key));
      if (serials.size > 0)
        await update(pools =>
          pools.map(entry =>
            entry.kind === info.kind &&
            entry.label === info.label &&
            sameKeys(entry.specKeys, specKeys)
              ? {
                  ...entry,
                  members: entry.members.map(member =>
                    serials.has(member.key)
                      ? { ...member, serial: serials.get(member.key) }
                      : member,
                  ),
                }
              : entry,
          ),
        );
      rev += 1;
      return undefined;
    })().finally(() => {
      findings.delete(id);
    });
    findings.set(id, finding);
    return finding;
  };

  /**
   * H: a manager with `addPoolMember` (a state provisioned later) takes
   * the restored additions into its own pool once; each entry is dropped
   * when the manager has it. A refusal keeps the entry, served here, and
   * is asked again.
   * @param {any} backend
   * @param {PoolInfo} info
   * @param {readonly string[]} specKeys
   * @param {{ stored: StoredMember, presence: any }[]} found
   */
  const migrate = async (backend, info, specKeys, found) => {
    if (found.length === 0 || backend === undefined) return false;
    const reached = await admins().catch(() => undefined);
    if (reached === undefined) return false;
    const { subscriptions } = reached;
    // eslint-disable-next-line no-underscore-dangle -- the Endo introspection method
    const names = await E(subscriptions)
      .__getMethodNames__()
      .catch(() => []);
    if (!names.includes('addPoolMember')) return false;
    /** @type {Set<string>} */
    const moved = new Set();
    for (const { stored: member, presence } of found) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await E(subscriptions).addPoolMember(backend, presence);
        moved.add(member.key);
        migrateCodes.delete(member.key);
      } catch (error) {
        if (!migrateCodes.has(member.key)) onError(error);
        migrateCodes.set(member.key, 'MIGRATE_FAILED');
      }
    }
    if (moved.size > 0) {
      // Kept as presences: served until the pool's next load has them.
      await update(pools =>
        pools.flatMap(entry => {
          if (
            entry.kind !== info.kind ||
            entry.label !== info.label ||
            !sameKeys(entry.specKeys, specKeys)
          )
            return [entry];
          const members = entry.members.filter(m => !moved.has(m.key));
          return members.length > 0 ? [{ ...entry, members }] : [];
        }),
      );
      onMigrated();
    }
    return migrateCodes.size > 0;
  };

  /**
   * The additions a pool serves now (active only, the pool's total at
   * most `maxPoolMembers`), and whether some are pending (asked again).
   * @param {any} backend the pool's `Backend` (for H's migration)
   * @param {PoolInfo} info
   * @param {readonly MemberEntry[]} specMembers the manager's `poolState`
   * @returns {Promise<{ members: MemberEntry[], pending: boolean }>}
   */
  const extrasOf = async (backend, info, specMembers) => {
    const specKeys = specMembers.map(entry => entry.key);
    const pool = entryOf(info, specKeys);
    if (pool === undefined)
      return { members: [], pending: fileProblem?.code === 'FILE_UNREADABLE' };
    const unknown = pool.members.filter(member => !presences.has(member.key));
    if (unknown.length > 0) await find(info, specMembers, unknown);
    const inSpec = new Set(specMembers.map(entry => entry.member));
    const kept = entryOf(info, specKeys)?.members ?? [];
    const found = kept.flatMap(member => {
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
      const gone = new Set(retired.map(({ member }) => member.key));
      await dropWhere(info, specKeys, member => gone.has(member.key));
    }
    const live = described.filter(
      ({ describedAs }) => describedAs?.state !== 'retired',
    );
    const migrating = await migrate(
      backend,
      info,
      specKeys,
      live.map(({ member, presence }) => ({ stored: member, presence })),
    ).catch(() => true);
    const room = Math.max(
      0,
      subscriptionLimits.maxPoolMembers -
        specMembers.filter(entry => entry.state === 'active').length,
    );
    /** @type {MemberEntry[]} */
    const members = live
      .slice(0, room)
      .map(({ member, presence, describedAs }) =>
        harden({
          member: presence,
          label: member.label,
          provider: member.provider,
          weight: describedAs?.weight ?? 1,
          key: member.key,
          state: 'active',
          ...(member.mark === undefined
            ? {}
            : { mark: harden({ ...member.mark }) }),
          ...(describedAs?.declared === undefined
            ? {}
            : { declared: describedAs.declared }),
        }),
      );
    const pending =
      migrating ||
      kept.some(member => pendingCodes.has(member.key)) ||
      fileProblem?.code === 'FILE_UNREADABLE';
    return { members, pending };
  };

  /**
   * What the page shows on a pool: the file's problem, or how many of its
   * kept additions are not restored and why (the latest code).
   * @param {PoolInfo} info
   * @param {readonly MemberEntry[]} specMembers
   * @returns {AdditionsNote | undefined}
   */
  const noteOf = (info, specMembers) => {
    if (fileProblem !== undefined) return harden({ code: fileProblem.code });
    const pool = entryOf(
      info,
      specMembers.map(entry => entry.key),
    );
    if (pool === undefined) return undefined;
    /** @type {string[]} */
    const codes = pool.members.flatMap(member => {
      const code = pendingCodes.get(member.key) ?? migrateCodes.get(member.key);
      return code === undefined ? [] : [code];
    });
    if (codes.length === 0) return undefined;
    return harden({ code: codes[codes.length - 1], unrestored: codes.length });
  };

  /**
   * Room for one more pool entry: entries of pools the manager no longer
   * lists are dropped first (`dropUnlisted`).
   * @param {StoredPool[]} pools
   */
  const roomFor = pools => {
    if (pools.length >= subscriptionLimits.maxPools)
      throw Error(subscriptionTexts.poolConflict);
    return pools;
  };

  /**
   * Add a subscription to a pool: the pool rules, the format check, then
   * the manager's `makeMember` and the kept addition (with the member's
   * creation serial, and the spec members' for a pool's first). Refused
   * while the file is unreadable or another process writes it.
   * Idempotent.
   * @param {any} backend
   * @param {PoolInfo} info the pool's `describe()`
   * @param {readonly MemberEntry[]} specMembers its `poolState().members`
   * @param {{ label: string, credential: any, weight?: number, declared?: any }} request
   */
  const add = (backend, info, specMembers, request) =>
    serialize(async () => {
      const provider = /** @type {Record<string, 'claude' | 'codex'>} */ (
        providerOfKind
      )[info.kind];
      if (provider === undefined) throw Error(subscriptionTexts.memberKind);
      poolsNow();
      if (fileProblem !== undefined)
        throw Error(subscriptionTexts.additionsUnreadable);
      if (!(await acquire())) throw Error(subscriptionTexts.additionsLocked);
      const { label, credential } = request;
      const key = await resolveSecret(credential);
      if (key === null)
        throw Error(subscriptionTextOf.credentialCheckFailed('UNKNOWN_SECRET'));
      const { members: extras } = await extrasOf(backend, info, specMembers);
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
      const specKeys = specMembers.map(entry => entry.key);
      // A pool's first addition: entries of pools the manager no longer
      // lists do not count towards `maxPools` (D).
      if (entryOf(info, specKeys) === undefined) await dropUnlisted();
      const before = entryOf(info, specKeys);
      if (
        before !== undefined &&
        before.members.filter(m => m.key !== key && m.label !== label).length >=
          subscriptionLimits.maxMembers
      )
        throw Error(subscriptionTexts.poolFull);
      const check = await checkCredential(credential, provider);
      if (!check.ok)
        throw Error(
          subscriptionTextOf.credentialCheckFailed(check.code ?? 'READ_FAILED'),
        );
      const reached = await admins();
      if (reached === undefined)
        throw Error(subscriptionTexts.additionsUnreachable);
      const { subscriptions } = reached;
      const member = await E(subscriptions).makeMember(
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
      const serial = await serialOfMember(subscriptions, member).catch(
        () => undefined,
      );
      const specSerials =
        before?.specSerials ??
        (await Promise.all(
          specMembers.map(entry =>
            entry.state === 'active'
              ? serialOfMember(subscriptions, entry.member).then(
                  found => found ?? null,
                )
              : null,
          ),
        ).catch(() => undefined));
      /** @type {StoredMember} */
      const addition = {
        key,
        label,
        provider,
        ...(serial === undefined ? {} : { serial }),
      };
      await write(pools => {
        const pool = pools.find(
          entry =>
            entry.kind === info.kind &&
            entry.label === info.label &&
            sameKeys(entry.specKeys, specKeys),
        );
        return pool
          ? pools.map(entry =>
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
              ...roomFor(pools),
              {
                kind: info.kind,
                label: info.label,
                specKeys: [...specKeys],
                ...(specSerials === undefined ? {} : { specSerials }),
                members: [addition],
              },
            ];
      }, true);
      presences.set(key, member);
      pendingCodes.delete(key);
      return member;
    });

  /**
   * E: keep the refusal marks of added members beside them (the pinned
   * manager keeps only its spec members' marks), so a restart does not
   * forget a 429. Only a changed mark is written.
   * @param {PoolInfo} info
   * @param {readonly MemberEntry[]} specMembers
   * @param {{ key: string, mark?: Mark }[]} changes
   */
  const recordMarks = (info, specMembers, changes) => {
    const specKeys = specMembers.map(entry => entry.key);
    /**
     * @param {Mark | undefined} a
     * @param {Mark | undefined} b
     */
    const sameMark = (a, b) =>
      a === b ||
      (a !== undefined &&
        b !== undefined &&
        a.untilMs === b.untilMs &&
        a.strikes === b.strikes &&
        a.sinceMs === b.sinceMs &&
        a.dated === b.dated);
    void update(pools => {
      let changed = false;
      const next = pools.map(entry => {
        if (
          entry.kind !== info.kind ||
          entry.label !== info.label ||
          !sameKeys(entry.specKeys, specKeys)
        )
          return entry;
        return {
          ...entry,
          members: entry.members.map(member => {
            const change = changes.find(c => c.key === member.key);
            if (change === undefined || sameMark(member.mark, change.mark))
              return member;
            changed = true;
            const { mark: _old, ...rest } = member;
            const mark =
              change.mark === undefined ? undefined : markOf(change.mark);
            return mark === undefined ? rest : { ...rest, mark };
          }),
        };
      });
      return changed ? next : undefined;
    });
  };

  return harden({
    rev: () => rev,
    extrasOf,
    add,
    noteOf,
    recordMarks,
    /** Whether adds are refused now: the file's problem code, if any. */
    problem: () => {
      poolsNow();
      return fileProblem?.code;
    },
    /**
     * Whether a pool has kept additions (the first selection waits for
     * them, `index.js`).
     * @param {PoolInfo} info
     * @param {readonly MemberEntry[]} specMembers
     */
    keeps: (info, specMembers) =>
      entryOf(
        info,
        specMembers.map(entry => entry.key),
      ) !== undefined,
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
      );
    },
    /** Wait for every queued add and write (tests, shutdown). */
    settled: async () => {
      await chain;
      await writing;
    },
    /** The kept additions (tests). */
    kept: () => poolsNow().map(pool => harden({ ...pool })),
    /** Stop writing and let the lock go (adapter close). */
    close: async () => {
      closed = true;
      await chain;
      await writing;
      release();
    },
  });
};
harden(makePoolAdditions);
