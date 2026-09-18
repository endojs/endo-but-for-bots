// @ts-check

import { createHash } from 'node:crypto';

import { Fail, makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const GENESIS_HASH = '0'.repeat(64);
const MAX_DEPTH = 64;

/**
 * Bounds, and what each protects. There is no lifetime ceiling on a journal:
 * the former 16 MiB total, and the anchor store that kept every head ever
 * written with its full entry inside it under a second such total, ended a
 * Codex session after a few hundred audited tool calls. What they stood in
 * for is bounded below by construction.
 *
 * `MAX_VALUE_BYTES` bounds one stored value — an entry or a content value —
 * because a value is one JSON document held whole while it is encoded,
 * hashed and written; `parseCanonicalAuditJson` refuses anything larger on
 * the way back in. It matches the 16 Mi frame the bounded readers hold.
 *
 * `INLINE_BYTES` is the size above which a payload's text field is stored as
 * its own content value and the entry carries `{ ref, bytes, preview }`
 * instead. The chain hash covers the reference, and the reference names the
 * content by its own hash, so the content is attested exactly as an inline
 * field would be; an entry is bounded by construction to its fixed fields
 * plus one inline field's worth per field. `PREVIEW_BYTES` is what an entry
 * keeps of such a field so a reader can tell what it was without the value.
 */
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const INLINE_BYTES = 64 * 1024;
const PREVIEW_BYTES = 4 * 1024;

const AuditWriterInterface = M.interface('AgentAuditWriter', {
  append: M.call(M.string()).optional(M.any()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

const AuditReaderInterface = M.interface('AgentAuditReader', {
  entries: M.call().optional(M.number(), M.number()).returns(M.promise()),
  content: M.call(M.string()).returns(M.promise()),
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

/**
 * The exact inverse of `canonicalAuditJson`.
 *
 * A journal kept in an Endo petstore needed no decoder: the daemon marshalled
 * the entries and gave them back as the copy data they went in as. A journal
 * kept in host files does, and `JSON.parse` is not it — an entry's `sequence`
 * is a bigint, which JSON cannot carry. Decoding the canonical form instead of
 * inventing a second encoding means the bytes on disk are the bytes the hash
 * chain is computed over, so a file is verifiable against the chain exactly as
 * written.
 *
 * Refuses anything the encoder would not have produced, including a record
 * whose keys are unsorted or repeated: such a document could re-encode to
 * different bytes and so to a different hash. `Object.fromEntries` is what
 * builds records here, because it defines own properties rather than assigning
 * them — a `__proto__` key stays a key.
 *
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
export const parseCanonicalAuditJson = (text, maxBytes = MAX_VALUE_BYTES) => {
  typeof text === 'string' || Fail`audit data must be text`;
  new TextEncoder().encode(text).byteLength <= maxBytes ||
    Fail`audit data exceeded ${maxBytes} bytes`;
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw makeError(X`audit data is not canonical JSON`);
  }
  /**
   * @param {unknown} node
   * @param {number} depth
   * @returns {unknown}
   */
  const decode = (node, depth) => {
    depth <= MAX_DEPTH || Fail`audit data exceeded ${MAX_DEPTH} levels`;
    (Array.isArray(node) && node.length >= 1 && node.length <= 2) ||
      Fail`audit data is not canonical JSON`;
    const tuple = /** @type {unknown[]} */ (node);
    const [kind, payload] = tuple;
    switch (kind) {
      case 'null':
        tuple.length === 1 || Fail`audit data is not canonical JSON`;
        return null;
      case 'boolean':
        typeof payload === 'boolean' || Fail`audit data is not canonical JSON`;
        return payload;
      case 'string':
        typeof payload === 'string' || Fail`audit data is not canonical JSON`;
        return payload;
      case 'number': {
        typeof payload === 'string' || Fail`audit data is not canonical JSON`;
        const value = payload === '-0' ? -0 : Number(payload);
        // Re-encode rather than trust the text: `1e3`, `01` and ` 1` all parse
        // and none of them is what the encoder writes.
        (Number.isFinite(value) &&
          `${Object.is(value, -0) ? '-0' : value}` === payload) ||
          Fail`audit data is not canonical JSON`;
        return value;
      }
      case 'bigint':
        (typeof payload === 'string' && /^-?(0|[1-9][0-9]*)$/.test(payload)) ||
          Fail`audit data is not canonical JSON`;
        return BigInt(/** @type {string} */ (payload));
      case 'array':
        Array.isArray(payload) || Fail`audit data is not canonical JSON`;
        return harden(
          /** @type {unknown[]} */ (payload).map(element =>
            decode(element, depth + 1),
          ),
        );
      case 'record': {
        Array.isArray(payload) || Fail`audit data is not canonical JSON`;
        /** @type {[string, unknown][]} */
        const entries = [];
        let previous;
        for (const entry of /** @type {unknown[]} */ (payload)) {
          (Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string') ||
            Fail`audit data is not canonical JSON`;
          const [key, encoded] = /** @type {[string, unknown]} */ (entry);
          previous === undefined ||
            key > previous ||
            Fail`audit data record keys must be sorted and distinct`;
          previous = key;
          entries.push([key, decode(encoded, depth + 1)]);
        }
        return harden(Object.fromEntries(entries));
      }
      default:
        throw makeError(X`audit data is not canonical JSON`);
    }
  };
  return decode(document, 0);
};
harden(parseCanonicalAuditJson);

/** @param {unknown} value */
export const hashAuditEntry = value =>
  createHash('sha256').update(canonicalAuditJson(value)).digest('hex');
harden(hashAuditEntry);

/**
 * Verify a chain whole. Linear in the entries, and transient: nothing here is
 * retained past the walk, and each entry is bounded by construction, so the
 * walk is what an audit chain costs to be one rather than a ceiling on how
 * long a session may run.
 *
 * @param {readonly any[]} entries
 * @param {{ journalId?: string, sessionId?: string, maxEntryBytes?: number }} [expected]
 */
export const verifyAuditEntries = (entries, expected = {}) => {
  let previousHash = GENESIS_HASH;
  let expectedSequence = 0n;
  for (const entry of entries) {
    const encoded = canonicalAuditJson(entry);
    const entryBytes = new TextEncoder().encode(encoded).byteLength;
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
      entryBytes > (expected.maxEntryBytes ?? MAX_VALUE_BYTES)
    ) {
      return harden({ ok: false, sequence: expectedSequence, previousHash });
    }
    previousHash = hashAuditEntry(entry);
    expectedSequence += 1n;
  }
  return harden({ ok: true, sequence: expectedSequence, previousHash });
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
 * @param {(head: any) => Promise<void>} [options.discardHead] Remove a head
 *   a newer one has superseded. Without it the anchor store keeps every head
 *   ever written, each with its entry inside, which is a second copy of the
 *   journal growing beside the first.
 * @param {(name: string, text: string) => Promise<void>} [options.storeContent]
 *   Store a payload field too large to keep inline. Without it a field beyond
 *   `inlineBytes` is refused, because a journal that cannot store the content
 *   cannot attest a reference to it.
 * @param {(name: string) => Promise<unknown>} [options.readContent]
 * @param {() => string} [options.now]
 * @param {number} [options.maxEntryBytes]
 * @param {number} [options.inlineBytes]
 * @param {number} [options.previewBytes]
 */
export const makeAuditJournal = ({
  journalId,
  sessionId,
  readEntries,
  appendEntry,
  readHead,
  writeHead,
  discardHead,
  storeContent,
  readContent,
  now = () => new Date().toISOString(),
  maxEntryBytes = MAX_VALUE_BYTES,
  inlineBytes = INLINE_BYTES,
  previewBytes = PREVIEW_BYTES,
}) => {
  let recovered = false;
  let tail = GENESIS_HASH;
  let nextSequence = 0n;
  /** @type {any} */
  let currentHead;
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
    currentHead = head;
    tail = verification.previousHash;
    nextSequence = verification.sequence;
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

  /**
   * Replace each payload text field beyond `inlineBytes` with a reference to
   * a content value named by the field's own hash. The content is stored
   * before the entry that refers to it, so a crash between the two leaves an
   * unreferenced value rather than a reference to nothing.
   *
   * @param {any} payload
   */
  const externalize = async payload => {
    if (typeof payload !== 'object' || payload === null) return payload;
    let result = payload;
    const large = Object.entries(payload).flatMap(([field, value]) => {
      if (typeof value !== 'string') return [];
      const bytes = new TextEncoder().encode(value).byteLength;
      return bytes > inlineBytes ? [{ field, value, bytes }] : [];
    });
    for (const { field, value, bytes } of large) {
      storeContent ||
        Fail`audit payload ${q(field)} of ${q(bytes)} bytes exceeds ${q(inlineBytes)} inline bytes and this journal stores no content`;
      bytes <= MAX_VALUE_BYTES ||
        Fail`audit payload ${q(field)} of ${q(bytes)} bytes exceeds the ${q(MAX_VALUE_BYTES)}-byte storage value bound`;
      const ref = `sha256:${createHash('sha256').update(value).digest('hex')}`;
      // eslint-disable-next-line no-await-in-loop
      await storeContent(ref, value);
      result = {
        ...result,
        [field]: {
          ref,
          bytes,
          preview: value.slice(0, previewBytes),
        },
      };
    }
    return harden(result);
  };

  const writer = makeExo('AgentAuditWriter', AuditWriterInterface, {
    async append(kind, payload = {}) {
      return inChainOrder(async () => {
        await recover();
        const entry = harden({
          version: 1,
          journalId,
          sessionId,
          sequence: nextSequence,
          at: now(),
          kind,
          previousHash: tail,
          payload: await externalize(payload),
        });
        const byteLength = new TextEncoder().encode(
          canonicalAuditJson(entry),
        ).byteLength;
        byteLength <= maxEntryBytes ||
          Fail`audit entry exceeded ${maxEntryBytes} bytes`;
        const nextHash = hashAuditEntry(entry);
        const head = makeHead(nextSequence + 1n, nextHash, entry);
        const previousHead = currentHead;
        try {
          // Authorize the exact immutable entry in the separately protected
          // anchor before exposing it to the entry store. Recovery may complete
          // this one prepared append, but never bless an unauthenticated suffix.
          await writeHead(head);
          await appendEntry(entry);
        } catch (error) {
          // Re-read and either repair or reject the independently anchored
          // state before permitting another append.
          recovered = false;
          throw error;
        }
        currentHead = head;
        tail = nextHash;
        nextSequence += 1n;
        // The head that authorized the previous entry has done its work: the
        // entry it named is in the store and the new head names this one.
        // Only the newest head is a witness; a failure to discard leaves a
        // stale one that recovery already knows to read past.
        if (discardHead && previousHead !== undefined) {
          await discardHead(previousHead).catch(() => {});
        }
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
    async content(ref) {
      /^sha256:[0-9a-f]{64}$/.test(ref) ||
        Fail`invalid audit content reference`;
      readContent || Fail`this journal stores no content`;
      const text = await readContent(ref);
      (typeof text === 'string' &&
        `sha256:${createHash('sha256').update(text).digest('hex')}` === ref) ||
        Fail`audit content does not match its reference`;
      return text;
    },
    async verify() {
      return inChainOrder(async () => {
        await recover();
        const loaded = [...(await readEntries())];
        const verification = verifyAuditEntries(loaded, {
          journalId,
          sessionId,
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
 * Store a journal in an operator-owned name-to-value store.
 *
 * The whole contract is four methods — `list`, `has`, `lookup`, `storeValue` —
 * which an Endo petstore answers and so does a directory of files
 * (`codex-session-store.js`). It was written against a petstore and named for
 * one; keeping a journal out of the host agent's naming authority is what
 * replaced that, and nothing here had to change.
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
 * @param {number} [options.inlineBytes]
 */
export const makeStoredAuditJournal = (
  powers,
  {
    journalId,
    sessionId,
    anchorPowers,
    prefix = `codex-audit-${sessionId}`,
    now,
    maxEntryBytes,
    inlineBytes,
  },
) => {
  anchorPowers || Fail`audit journal requires independent anchor powers`;
  anchorPowers !== powers ||
    Fail`audit journal entry and anchor powers must be distinct`;
  /^[a-zA-Z0-9._-]+$/.test(prefix) ||
    Fail`audit journal prefix contains unsafe characters`;
  const entryName = sequence => `${prefix}-${`${sequence}`.padStart(20, '0')}`;
  const headName = sequence =>
    `${prefix}-head-${`${sequence}`.padStart(20, '0')}`;
  const contentName = ref => `${prefix}-content-${ref.slice('sha256:'.length)}`;
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
  const storeContent = async (ref, text) => {
    await null;
    const name = contentName(ref);
    // Content is named by its hash, so an existing value of that name is
    // this value; a repeated result costs one value, not one per entry.
    if (await E(powers).has(name)) return;
    await E(powers).storeValue(text, name);
  };
  const readContent = async ref => E(powers).lookup(contentName(ref));
  const headNames = async () => {
    const names = await E(anchorPowers).list();
    const headPrefix = `${prefix}-head-`;
    return (Array.isArray(names) ? names : [])
      .filter(
        name =>
          typeof name === 'string' &&
          name.startsWith(headPrefix) &&
          /^[0-9]{20}$/.test(name.slice(headPrefix.length)),
      )
      .sort();
  };
  // Only the newest head is a witness; an older one still present is the
  // one `discardHead` did not get to, and reads past it.
  const readHead = async () => {
    const selected = await headNames();
    if (selected.length === 0) return undefined;
    return E(anchorPowers).lookup(selected[selected.length - 1]);
  };
  const writeHead = async head => {
    const name = headName(head.sequence);
    if (await E(anchorPowers).has(name)) {
      const existing = await E(anchorPowers).lookup(name);
      if (canonicalAuditJson(existing) === canonicalAuditJson(head)) return;
      throw makeError(X`audit journal head already exists: ${q(name)}`);
    }
    await E(anchorPowers).storeValue(head, name);
  };
  const discardHead = async head => {
    await E(anchorPowers).remove(headName(head.sequence));
  };
  return makeAuditJournal({
    journalId,
    sessionId,
    readEntries,
    appendEntry,
    readHead,
    writeHead,
    discardHead,
    storeContent,
    readContent,
    ...(now ? { now } : {}),
    ...(maxEntryBytes ? { maxEntryBytes } : {}),
    ...(inlineBytes ? { inlineBytes } : {}),
  });
};
harden(makeStoredAuditJournal);
