// @ts-check

import { createHash } from 'node:crypto';

import { Fail, makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const GENESIS_HASH = '0'.repeat(64);
const MAX_DEPTH = 64;
const RESERVED_LIFECYCLE_KINDS = harden([
  'cleanup-failed',
  'session-close-deferred',
  'session-close-requested',
  'session-closed',
  'session-failed',
  'session-provisioning-cleanup-failed',
  'session-provisioning-failed',
  'session-teardown-failed',
]);

const AuditWriterInterface = M.interface('AgentAuditWriter', {
  append: M.call(M.string()).optional(M.any()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

const AuditReaderInterface = M.interface('AgentAuditReader', {
  entries: M.call().optional(M.number(), M.number()).returns(M.promise()),
  verify: M.call().returns(M.promise()),
  help: M.call().returns(M.string()),
});

/**
 * Canonically encode capability-free audit data.
 *
 * Audit records deliberately accept a smaller domain than ordinary passable
 * values. This keeps their disk representation stable and rejects accidental
 * capability leakage at the trust boundary.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export const canonicalAuditJson = (value, depth = 0) => {
  depth <= MAX_DEPTH || Fail`audit data exceeded ${MAX_DEPTH} levels`;
  if (value === null) return '["null"]';
  if (typeof value === 'boolean') {
    return `["boolean",${JSON.stringify(value)}]`;
  }
  if (typeof value === 'string') {
    return `["string",${JSON.stringify(value)}]`;
  }
  if (typeof value === 'number') {
    Number.isFinite(value) || Fail`audit data contains a non-finite number`;
    return `["number",${JSON.stringify(
      Object.is(value, -0) ? '-0' : `${value}`,
    )}]`;
  }
  if (typeof value === 'bigint') {
    return `["bigint",${JSON.stringify(`${value}`)}]`;
  }
  if (Array.isArray(value)) {
    return `["array",[${value
      .map(element => canonicalAuditJson(element, depth + 1))
      .join(',')}]]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    prototype === Object.prototype ||
      prototype === null ||
      Fail`audit data must contain only copy records, not ${q(
        prototype?.constructor?.name || 'an exotic object',
      )}`;
    return `["record",[${Object.keys(value)
      .sort()
      .map(
        key =>
          `[${JSON.stringify(key)},${canonicalAuditJson(
            /** @type {Record<string, unknown>} */ (value)[key],
            depth + 1,
          )}]`,
      )
      .join(',')}]]`;
  }
  throw makeError(X`audit data cannot contain ${q(typeof value)} values`);
};
harden(canonicalAuditJson);

/** @param {unknown} value */
export const hashAuditEntry = value =>
  createHash('sha256').update(canonicalAuditJson(value)).digest('hex');
harden(hashAuditEntry);

/**
 * @param {readonly any[]} entries
 * @param {{ journalId?: string, sessionId?: string, maxEntries?: number, maxTotalBytes?: number, maxEntryBytes?: number }} [expected]
 */
export const verifyAuditEntries = (entries, expected = {}) => {
  if (entries.length > (expected.maxEntries ?? Number.POSITIVE_INFINITY)) {
    return harden({ ok: false, sequence: 0n, previousHash: GENESIS_HASH });
  }
  let previousHash = GENESIS_HASH;
  let expectedSequence = 0n;
  let totalBytes = 0;
  for (const entry of entries) {
    const encoded = canonicalAuditJson(entry);
    const entryBytes = new TextEncoder().encode(encoded).byteLength;
    totalBytes += entryBytes;
    if (
      entry?.version !== 1 ||
      entry?.sequence !== expectedSequence ||
      entry?.previousHash !== previousHash ||
      typeof entry?.at !== 'string' ||
      typeof entry?.kind !== 'string' ||
      entry.kind === '' ||
      (expected.journalId !== undefined &&
        entry.journalId !== expected.journalId) ||
      (expected.sessionId !== undefined &&
        entry.sessionId !== expected.sessionId) ||
      entryBytes > (expected.maxEntryBytes ?? Number.POSITIVE_INFINITY) ||
      totalBytes > (expected.maxTotalBytes ?? Number.POSITIVE_INFINITY)
    ) {
      return harden({ ok: false, sequence: expectedSequence, previousHash });
    }
    previousHash = hashAuditEntry(entry);
    expectedSequence += 1n;
  }
  return harden({
    ok: true,
    sequence: expectedSequence,
    previousHash,
    totalBytes,
  });
};
harden(verifyAuditEntries);

/**
 * Make an append-only, hash-chained audit journal with separated writer and
 * reader facets. The storage callbacks are held only by this trusted object.
 *
 * `appendEntry` must reject an existing sequence rather than overwrite it.
 * Every append is awaited and serialized before the caller may continue.
 *
 * @param {object} options
 * @param {string} options.journalId
 * @param {string} options.sessionId
 * @param {() => Promise<readonly any[]>} options.readEntries
 * @param {(entry: any) => Promise<void>} options.appendEntry
 * @param {() => Promise<any | undefined>} options.readHead
 * @param {(head: any) => Promise<void>} options.writeHead
 * @param {() => string} [options.now]
 * @param {number} [options.maxEntryBytes]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxTotalBytes]
 * @param {number} [options.reservedLifecycleEntries]
 * @param {number} [options.reservedLifecycleBytes]
 */
export const makeAuditJournal = ({
  journalId,
  sessionId,
  readEntries,
  appendEntry,
  readHead,
  writeHead,
  now = () => new Date().toISOString(),
  maxEntryBytes = 16 * 1024 * 1024,
  maxEntries = 100_000,
  maxTotalBytes = 256 * 1024 * 1024,
  reservedLifecycleEntries = Math.min(16, maxEntries),
  reservedLifecycleBytes = Math.min(64 * 1024, maxTotalBytes),
}) => {
  (Number.isInteger(reservedLifecycleEntries) &&
    reservedLifecycleEntries >= 0 &&
    reservedLifecycleEntries <= maxEntries) ||
    Fail`invalid audit lifecycle entry reserve`;
  (Number.isInteger(reservedLifecycleBytes) &&
    reservedLifecycleBytes >= 0 &&
    reservedLifecycleBytes <= maxTotalBytes) ||
    Fail`invalid audit lifecycle byte reserve`;
  let recovered = false;
  let tail = GENESIS_HASH;
  let nextSequence = 0n;
  let totalBytes = 0;
  let writeChain = Promise.resolve();

  const makeHead = (sequence, hash, entry) =>
    harden({ version: 1, journalId, sessionId, sequence, hash, entry });

  const assertHead = (head, verification, entry) => {
    if (
      Object.keys(head || {})
        .sort()
        .join(',') !== 'entry,hash,journalId,sequence,sessionId,version' ||
      head?.version !== 1 ||
      head?.journalId !== journalId ||
      head?.sessionId !== sessionId ||
      head?.sequence !== verification.sequence ||
      head?.hash !== verification.previousHash ||
      canonicalAuditJson(head?.entry) !== canonicalAuditJson(entry)
    ) {
      throw makeError(X`audit journal ${q(journalId)} head is corrupt`);
    }
  };

  const recoverOnce = async () => {
    await null;
    if (recovered) return;
    const loaded = [...(await readEntries())];
    let verification = verifyAuditEntries(loaded, {
      journalId,
      sessionId,
      maxEntries,
      maxTotalBytes,
      maxEntryBytes,
    });
    if (!verification.ok) {
      throw makeError(
        X`audit journal ${q(journalId)} is corrupt at sequence ${q(
          verification.sequence,
        )}`,
      );
    }
    const head = await readHead();
    if (verification.sequence === 0n) {
      if (head === undefined) {
        recovered = true;
        return;
      }
      if (head?.sequence !== 1n) {
        throw makeError(X`audit journal ${q(journalId)} head is corrupt`);
      }
      const pending = verifyAuditEntries([head.entry], {
        journalId,
        sessionId,
        maxEntries,
        maxTotalBytes,
        maxEntryBytes,
      });
      assertHead(head, pending, head.entry);
      await appendEntry(head.entry);
      loaded.push(head.entry);
      verification = pending;
    } else if (head === undefined) {
      throw makeError(X`audit journal ${q(journalId)} head is missing`);
    } else if (
      head.sequence === verification.sequence + 1n &&
      head.entry !== undefined
    ) {
      const completed = verifyAuditEntries([...loaded, head.entry], {
        journalId,
        sessionId,
        maxEntries,
        maxTotalBytes,
        maxEntryBytes,
      });
      assertHead(head, completed, head.entry);
      // The independently protected head is a write-ahead authorization for
      // exactly this entry. Complete only that prepared append; an entry-store
      // holder cannot synthesize a hash-chain suffix and move the anchor.
      await appendEntry(head.entry);
      loaded.push(head.entry);
      verification = completed;
    } else {
      assertHead(head, verification, loaded.at(-1));
    }
    recovered = true;
    tail = verification.previousHash;
    nextSequence = verification.sequence;
    totalBytes =
      'totalBytes' in verification
        ? /** @type {number} */ (verification.totalBytes)
        : 0;
  };

  /**
   * Recovery is idempotent only if it happens once.
   *
   * `recovered` is set at the end of a long asynchronous walk, so two readers
   * that both arrive before it flips — a health check racing the next append,
   * say — each took the write-ahead replay branch and each called
   * `appendEntry` for the same head entry. Against a strict entry store the
   * second rejects, and because `verify()` wraps only the head read, that
   * rejection escaped as a throw instead of the `{ ok: false }` record its
   * contract promises. Memoizing the in-flight promise makes concurrent
   * callers share one recovery; a failure clears it so a later call retries.
   *
   * @type {Promise<void> | undefined}
   */
  let recovering;
  const recover = () => {
    if (recovered) return Promise.resolve();
    if (!recovering) {
      recovering = recoverOnce().finally(() => {
        recovering = undefined;
      });
    }
    return recovering;
  };

  // Every append, and every read, takes its turn on one chain. A reader that
  // merely waited for the appends already queued could still interleave with
  // one issued a moment later, and between that append's anchor write and its
  // entry write the store shows a head one ahead of the entries: a legitimate
  // append reported as a corrupt journal to an operator's health check.
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const inChainOrder = operation => {
    const result = writeChain.then(operation);
    writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const writer = makeExo('AgentAuditWriter', AuditWriterInterface, {
    async append(kind, payload = {}) {
      return inChainOrder(async () => {
        await recover();
        const lifecycle = RESERVED_LIFECYCLE_KINDS.includes(kind);
        if (!lifecycle && reservedLifecycleEntries > 0) {
          nextSequence < BigInt(maxEntries - reservedLifecycleEntries) ||
            Fail`audit journal entered its lifecycle reserve`;
        }
        nextSequence < BigInt(maxEntries) ||
          Fail`audit journal exceeded ${maxEntries} entries`;
        const entry = harden({
          version: 1,
          journalId,
          sessionId,
          sequence: nextSequence,
          at: now(),
          kind,
          previousHash: tail,
          payload,
        });
        const byteLength = new TextEncoder().encode(
          canonicalAuditJson(entry),
        ).byteLength;
        byteLength <= maxEntryBytes ||
          Fail`audit entry exceeded ${maxEntryBytes} bytes`;
        if (!lifecycle && reservedLifecycleBytes > 0) {
          totalBytes + byteLength <= maxTotalBytes - reservedLifecycleBytes ||
            Fail`audit journal entered its lifecycle byte reserve`;
        }
        totalBytes + byteLength <= maxTotalBytes ||
          Fail`audit journal exceeded ${maxTotalBytes} bytes`;
        const nextHash = hashAuditEntry(entry);
        try {
          // Authorize the exact immutable entry in the separately protected
          // anchor before exposing it to the entry store. Recovery may complete
          // this one prepared append, but never bless an unauthenticated suffix.
          await writeHead(makeHead(nextSequence + 1n, nextHash, entry));
          await appendEntry(entry);
        } catch (error) {
          // Re-read and either repair or reject the independently anchored
          // state before permitting another append.
          recovered = false;
          throw error;
        }
        tail = nextHash;
        nextSequence += 1n;
        totalBytes += byteLength;
        return harden({ sequence: entry.sequence, hash: tail });
      });
    },
    help() {
      return 'Append capability-free security events to the durable audit journal.';
    },
  });

  const reader = makeExo('AgentAuditReader', AuditReaderInterface, {
    async entries(start = 0, limit = 1000) {
      (Number.isInteger(start) && start >= 0) || Fail`invalid audit page start`;
      (Number.isInteger(limit) && limit > 0 && limit <= 1000) ||
        Fail`invalid audit page limit`;
      return inChainOrder(async () => {
        await recover();
        const loaded = [...(await readEntries())];
        const verification = verifyAuditEntries(loaded, {
          journalId,
          sessionId,
          maxEntries,
          maxTotalBytes,
          maxEntryBytes,
        });
        verification.ok || Fail`audit journal failed verification`;
        const head = await readHead();
        if (verification.sequence !== 0n || head !== undefined) {
          assertHead(head, verification, loaded.at(-1));
        }
        return harden(loaded.slice(start, start + limit));
      });
    },
    async verify() {
      return inChainOrder(async () => {
        await recover();
        const loaded = [...(await readEntries())];
        const verification = verifyAuditEntries(loaded, {
          journalId,
          sessionId,
          maxEntries,
          maxTotalBytes,
          maxEntryBytes,
        });
        if (!verification.ok) return verification;
        try {
          const head = await readHead();
          if (verification.sequence !== 0n || head !== undefined) {
            assertHead(head, verification, loaded.at(-1));
          }
          return verification;
        } catch {
          return harden({
            ok: false,
            sequence: verification.sequence,
            previousHash: verification.previousHash,
          });
        }
      });
    },
    help() {
      return 'Read and verify the durable, hash-chained agent audit journal.';
    },
  });

  return harden({ writer, reader });
};
harden(makeAuditJournal);

/**
 * Store a journal in an operator-owned Endo petstore namespace.
 *
 * Pass factory or operator powers, never session guest powers. The returned
 * reader must likewise remain outside the model-facing object graph.
 *
 * @param {any} powers
 * @param {object} options
 * @param {string} options.journalId
 * @param {string} options.sessionId
 * @param {any} options.anchorPowers independently protected append-only powers
 * @param {string} [options.prefix]
 * @param {() => string} [options.now]
 * @param {number} [options.maxEntryBytes]
 * @param {number} [options.maxTotalBytes]
 * @param {number} [options.maxAnchorBytes]
 * @param {number} [options.reservedAnchorBytes]
 */
export const makePetstoreAuditJournal = (
  powers,
  {
    journalId,
    sessionId,
    anchorPowers,
    prefix = `codex-audit-${sessionId}`,
    now,
    maxEntryBytes,
    maxTotalBytes,
    maxAnchorBytes = 256 * 1024 * 1024,
    reservedAnchorBytes = Math.min(64 * 1024, maxAnchorBytes),
  },
) => {
  anchorPowers || Fail`audit journal requires independent anchor powers`;
  anchorPowers !== powers ||
    Fail`audit journal entry and anchor powers must be distinct`;
  /^[a-zA-Z0-9._-]+$/.test(prefix) ||
    Fail`audit journal prefix contains unsafe characters`;
  (Number.isInteger(maxAnchorBytes) && maxAnchorBytes > 0) ||
    Fail`invalid audit anchor byte limit`;
  (Number.isInteger(reservedAnchorBytes) &&
    reservedAnchorBytes >= 0 &&
    reservedAnchorBytes <= maxAnchorBytes) ||
    Fail`invalid audit anchor byte reserve`;
  const entryName = sequence => `${prefix}-${`${sequence}`.padStart(20, '0')}`;
  const headName = sequence =>
    `${prefix}-head-${`${sequence}`.padStart(20, '0')}`;
  const readEntries = async () => {
    const names = await E(powers).list();
    const selected = (Array.isArray(names) ? names : [])
      .filter(name =>
        typeof name === 'string'
          ? name.startsWith(`${prefix}-`) &&
            /^[0-9]{20}$/.test(name.slice(prefix.length + 1))
          : false,
      )
      .sort();
    const entries = [];
    for (const name of selected) {
      // eslint-disable-next-line no-await-in-loop
      entries.push(await E(powers).lookup(name));
    }
    return harden(entries);
  };
  const appendEntry = async entry => {
    await null;
    const name = entryName(entry.sequence);
    if (await E(powers).has(name)) {
      throw makeError(X`audit journal sequence already exists: ${q(name)}`);
    }
    await E(powers).storeValue(entry, name);
  };
  let anchorBytes = 0;
  const readHead = async () => {
    const names = await E(anchorPowers).list();
    const headPrefix = `${prefix}-head-`;
    const selected = (Array.isArray(names) ? names : [])
      .filter(
        name =>
          typeof name === 'string' &&
          name.startsWith(headPrefix) &&
          /^[0-9]{20}$/.test(name.slice(headPrefix.length)),
      )
      .sort();
    if (selected.length === 0) return undefined;
    anchorBytes = 0;
    let last;
    for (const name of selected) {
      // eslint-disable-next-line no-await-in-loop
      last = await E(anchorPowers).lookup(name);
      anchorBytes += new TextEncoder().encode(
        canonicalAuditJson(last),
      ).byteLength;
      anchorBytes <= maxAnchorBytes ||
        Fail`audit anchor store exceeded ${maxAnchorBytes} bytes`;
    }
    return last;
  };
  const writeHead = async head => {
    const name = headName(head.sequence);
    if (await E(anchorPowers).has(name)) {
      const existing = await E(anchorPowers).lookup(name);
      if (canonicalAuditJson(existing) === canonicalAuditJson(head)) return;
      throw makeError(X`audit journal head already exists: ${q(name)}`);
    }
    const headBytes = new TextEncoder().encode(
      canonicalAuditJson(head),
    ).byteLength;
    const lifecycle = RESERVED_LIFECYCLE_KINDS.includes(head.entry?.kind);
    if (!lifecycle && reservedAnchorBytes > 0) {
      anchorBytes + headBytes <= maxAnchorBytes - reservedAnchorBytes ||
        Fail`audit anchor store entered its lifecycle reserve`;
    }
    anchorBytes + headBytes <= maxAnchorBytes ||
      Fail`audit anchor store exceeded ${maxAnchorBytes} bytes`;
    await E(anchorPowers).storeValue(head, name);
    anchorBytes += headBytes;
  };
  return makeAuditJournal({
    journalId,
    sessionId,
    readEntries,
    appendEntry,
    readHead,
    writeHead,
    ...(now ? { now } : {}),
    ...(maxEntryBytes ? { maxEntryBytes } : {}),
    ...(maxTotalBytes ? { maxTotalBytes } : {}),
  });
};
harden(makePetstoreAuditJournal);
