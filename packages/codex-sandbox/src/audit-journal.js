// @ts-check
import { createHash } from 'node:crypto';
import { Fail, makeError, q, X } from '@endo/errors';
import { canonicalJson } from '@endo/hosted-agent/canonical-json.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

// Per-value bounds, not a lifetime history ceiling.
const MAX_DEPTH = 64;
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const INLINE_BYTES = 64 * 1024;
const PREVIEW_BYTES = 4 * 1024;
const AuditWriterInterface = M.interface('AgentAuditWriter', {
  append: M.call(M.string()).optional(M.any()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

export const canonicalAuditJson = canonicalJson;
harden(canonicalAuditJson);

/**
 * The exact inverse of `canonicalAuditJson`.
 *
 * Retains exact capability-free values, including bigint sequences.
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

/**
 * Required diagnostic writes, not effect or native recovery authority.
 * The owner must provide one writer per store. A rejected operation permanently
 * fences this incarnation: an atomic write may have landed without acknowledgement.
 *
 * @param {object} options
 * @param {string} options.journalId
 * @param {string} options.sessionId
 * @param {() => Promise<{nextSequence: bigint, lastEntry?: any}>} options.readPosition
 * @param {(entry: any) => Promise<void>} options.appendEntry
 * @param {(ref: string, text: string) => Promise<void>} [options.storeContent]
 * @param {() => string} [options.now]
 * @param {number} [options.maxEntryBytes]
 * @param {number} [options.inlineBytes]
 * @param {number} [options.previewBytes]
 */
export const makeAuditJournal = ({
  journalId,
  sessionId,
  readPosition,
  appendEntry,
  storeContent,
  now = () => new Date().toISOString(),
  maxEntryBytes = MAX_VALUE_BYTES,
  inlineBytes = INLINE_BYTES,
  previewBytes = PREVIEW_BYTES,
}) => {
  let recovered = false;
  let nextSequence = 0n;
  let writeChain = Promise.resolve();
  let failed = false;
  /** @type {unknown} */
  let failure;
  const recover = async () => {
    if (recovered) return;
    const position = await readPosition();
    const { lastEntry } = position;
    (typeof position.nextSequence === 'bigint' &&
      position.nextSequence >= 0n) ||
      Fail`Invalid diagnostic position`;
    if (position.nextSequence === 0n) {
      lastEntry === undefined || Fail`Unexpected diagnostic tail`;
    } else {
      (lastEntry?.version === 2 &&
        lastEntry.journalId === journalId &&
        lastEntry.sessionId === sessionId &&
        lastEntry.sequence === position.nextSequence - 1n &&
        typeof lastEntry.at === 'string' &&
        typeof lastEntry.kind === 'string' &&
        lastEntry.kind !== '' &&
        Object.keys(lastEntry).sort().join(',') ===
          'at,journalId,kind,payload,sequence,sessionId,version' &&
        new TextEncoder().encode(canonicalAuditJson(lastEntry)).byteLength <=
          maxEntryBytes) ||
        Fail`Invalid diagnostic tail; reset old or damaged state`;
    }
    nextSequence = position.nextSequence;
    recovered = true;
  };

  const externalize = async payload => {
    if (typeof payload !== 'object' || payload === null) return payload;
    let result = payload;
    const large = Object.entries(payload).flatMap(([field, value]) => {
      if (typeof value !== 'string') return [];
      const bytes = new TextEncoder().encode(value).byteLength;
      return bytes > inlineBytes ? [{ field, value, bytes }] : [];
    });
    for (const { field, value, bytes } of large) {
      if (!storeContent)
        throw Fail`audit payload ${q(field)} of ${q(bytes)} bytes exceeds ${q(inlineBytes)} inline bytes and this journal stores no content`;
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
    append(kind, payload = {}) {
      const operation = writeChain.then(async () => {
        if (failed) throw failure;
        try {
          await recover();
          kind !== '' || Fail`Diagnostic kind must not be empty`;
          const entry = harden({
            version: 2,
            journalId,
            sessionId,
            sequence: nextSequence,
            at: now(),
            kind,
            payload: await externalize(payload),
          });
          new TextEncoder().encode(canonicalAuditJson(entry)).byteLength <=
            maxEntryBytes || Fail`audit entry exceeded ${maxEntryBytes} bytes`;
          await appendEntry(entry);
          nextSequence += 1n;
          return harden({ sequence: entry.sequence });
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        }
      });
      writeChain = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    help: () =>
      'Append capability-free required diagnostics to host-private storage.',
  });
  return harden({ writer });
};
harden(makeAuditJournal);

/**
 * Compose the diagnostic writer with the existing atomic host value store.
 * Startup enumerates entry names and reads only the final entry. No historical
 * payload scan, hash chain, independent anchor, or automatic repair is promised.
 * Old formats refuse before appending; retirement is explicit, not migration.
 * @param {any} powers
 * @param {{journalId: string, sessionId: string, prefix?: string,
 *   now?: () => string, maxEntryBytes?: number, inlineBytes?: number}} options
 */
export const makeStoredAuditJournal = (
  powers,
  {
    journalId,
    sessionId,
    prefix = `codex-audit-${sessionId}`,
    now,
    maxEntryBytes,
    inlineBytes,
  },
) => {
  /^[a-zA-Z0-9._-]+$/.test(prefix) || Fail`Invalid diagnostic prefix`;
  const entryName = sequence => {
    const digits = `${sequence}`.padStart(20, '0');
    /^[0-9]{20}$/.test(digits) ||
      Fail`Diagnostic sequence exceeds filename capacity`;
    return `${prefix}-${digits}`;
  };
  const contentName = ref => `${prefix}-content-${ref.slice('sha256:'.length)}`;
  const readPosition = async () => {
    const names = await E(powers).list();
    Array.isArray(names) || Fail`Invalid diagnostic inventory`;
    const entries = [];
    for (const name of names) {
      typeof name === 'string' || Fail`Invalid diagnostic filename`;
      if (name.startsWith(`${prefix}-`)) {
        const suffix = name.slice(prefix.length + 1);
        if (!/^content-[0-9a-f]{64}$/.test(suffix)) {
          /^[0-9]{20}$/.test(suffix) || Fail`Invalid diagnostic filename`;
          entries.push(name);
        }
      }
    }
    entries.sort();
    let nextSequence = 0n;
    for (const name of entries) {
      name === entryName(nextSequence) || Fail`Diagnostic sequence gap`;
      nextSequence += 1n;
    }
    const lastName = entries.at(-1);
    return {
      nextSequence,
      ...(lastName === undefined
        ? {}
        : { lastEntry: await E(powers).lookup(lastName) }),
    };
  };
  const appendEntry = async entry => {
    const name = entryName(entry.sequence);
    !(await E(powers).has(name)) || Fail`Diagnostic entry already exists`;
    await E(powers).storeValue(entry, name);
  };
  const storeContent = async (ref, text) => {
    const name = contentName(ref);
    if (await E(powers).has(name)) return;
    await E(powers).storeValue(text, name);
  };
  return makeAuditJournal({
    journalId,
    sessionId,
    readPosition,
    appendEntry,
    storeContent,
    ...(now ? { now } : {}),
    ...(maxEntryBytes ? { maxEntryBytes } : {}),
    ...(inlineBytes ? { inlineBytes } : {}),
  });
};
harden(makeStoredAuditJournal);
