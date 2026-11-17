// @ts-check
/**
 * The stack's own record of a conversation, as JSON Lines (M1a W1a.1).
 *
 * A subset of Endo `packages/hosted-agent/src/transcript-records.js` at
 * commit `1315bef86` (516 lines): `assertTranscriptRecord`,
 * `encodeTranscriptRecord`, `encodeTranscript`, `parseTranscript` and
 * `pairToolCalls`, with the source's names, signatures and texts. Left out:
 * `selectActiveTranscript`, `renderTranscriptDialogue`, `responsesApiItems`
 * and `readResponsesApiItems` (CLI restoration and compaction, later
 * milestones), and with them the import of `image-result.js`. Changes for
 * vats:
 * - `Fail` and `q` are prelude globals (the source imported `@endo/errors`);
 * - `encodeTranscript` joins an array of lines instead of growing a string
 *   with `+=` in its loop (rule 12.4: string growth in a loop is the
 *   pattern that exhausted a vat's heap in the survey, reuse.md:296);
 * - nothing else. Record keys are already a fixed vocabulary (the
 *   `RECORD_FIELDS` table) and pairing is keyed by a `Map`, so the module
 *   meets rule 12.10 as written.
 *
 * Two cautions for vat callers, which the source does not need:
 * - `parseTranscript` calls `JSON.parse`, which creates every key of every
 *   line's object before `assertTranscriptRecord` refuses an unknown one,
 *   and each fresh key costs the vat one of its ~57,000 names for life
 *   (rule 12.10, J-0191). A vat may parse only text the harness encoded
 *   itself; text from a model, a tool or a client is parsed outside vats.
 * - Nothing here is bounded ("No size bound", below): encoding or parsing a
 *   long transcript in one crank can exceed the crank budget or the heap.
 *   A vat caller works in pages (architecture 9).
 *
 * The source's description follows.
 *
 * The stack's own record of a hosted conversation, in one format every
 * adapter translates from. The encoding is JSON Lines: one self-describing
 * object per line, no enclosing array. Appending never rewrites a closing
 * character, and a truncated tail costs the last record rather than the
 * file — which matters for a record that is appended to on every turn and
 * read back after a crash.
 *
 * @module
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Fail, q } = /** @type {GuestGlobals} */ (globalThis);

/** Roles a dialogue record may carry. Tool traffic has its own kinds. */
const MESSAGE_ROLES = harden(['user', 'assistant']);

/**
 * The fields each kind carries, in the order they are written. Field order is
 * fixed so the same record always encodes to the same bytes, which is what
 * lets a stream be compared, deduplicated, or hash-chained the way
 * `canonicalAuditJson` chains the audit journal.
 */
const RECORD_FIELDS = harden({
  message: harden(['kind', 'role', 'content', 'providerContext']),
  'tool-call': harden(['kind', 'id', 'name', 'args']),
  'tool-result': harden(['kind', 'id', 'content', 'failed']),
  compaction: harden(['kind', 'summary', 'retainedTail']),
  'native-context': harden(['kind', 'format', 'payload', 'context']),
});

/** Fields a kind may omit. Everything else is required. */
const OPTIONAL_FIELDS = harden({
  message: harden(['providerContext']),
  'tool-call': harden([]),
  'tool-result': harden(['failed']),
  compaction: harden(['retainedTail']),
  'native-context': harden([]),
});

const KINDS = harden(Object.keys(RECORD_FIELDS));

/**
 * @typedef {{ kind: 'message', role: 'user' | 'assistant', content: string, providerContext?: {format: string, payload: string} }} TranscriptMessage
 * @typedef {{ kind: 'tool-call', id: string, name: string, args: string }} TranscriptToolCall
 * @typedef {{ kind: 'tool-result', id: string, content: string, failed?: boolean }} TranscriptToolResult
 * @typedef {TranscriptMessage | TranscriptToolCall | TranscriptToolResult} TranscriptContextRecord
 * @typedef {{ kind: 'compaction', summary: string, retainedTail?: readonly TranscriptContextRecord[] }} TranscriptCompaction
 * @typedef {{ kind: 'native-context', format: string, payload: string, context: readonly (TranscriptContextRecord | {kind: 'compaction', summary: string})[] }} TranscriptNativeContext
 * @typedef {TranscriptMessage | TranscriptToolCall | TranscriptToolResult | TranscriptCompaction | TranscriptNativeContext} TranscriptRecord
 */

/**
 * Validate one record.
 *
 * Deliberately narrow: dialogue text, a tool's name and its arguments as the
 * CLI produced them, and nothing else. A record is data the stack wrote about
 * a conversation, never a capability, a path, or a live reference.
 *
 * No size bound. A conversation is restored on every revival until it is
 * deleted, so a record too large to restore would be a conversation the stack
 * had silently stopped owning. Context limits are expressed by a `compaction`
 * record, not by the stack declining to speak. (In a vat the guards and the
 * frame bound the inputs; see the module note.)
 *
 * @param {unknown} candidate
 * @returns {TranscriptRecord}
 */
export const assertTranscriptRecord = candidate => {
  (typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate)) ||
    Fail`transcript record must be an object, got ${q(candidate)}`;
  const record = /** @type {Record<string, unknown>} */ (candidate);
  const { kind } = record;
  (typeof kind === 'string' && KINDS.includes(kind)) ||
    Fail`transcript record kind ${q(kind)} is not one of ${q(KINDS)}`;
  // Read as plain string lists (the source indexed with a string key).
  /** @type {readonly string[]} */
  const fields =
    RECORD_FIELDS[/** @type {keyof typeof RECORD_FIELDS} */ (kind)];
  /** @type {readonly string[]} */
  const optional =
    OPTIONAL_FIELDS[/** @type {keyof typeof OPTIONAL_FIELDS} */ (kind)];
  const present = Object.keys(record).sort();
  for (const key of present) {
    fields.includes(key) ||
      Fail`transcript ${q(kind)} record has unknown field ${q(key)}`;
  }
  for (const key of fields) {
    optional.includes(key) ||
      Object.hasOwn(record, key) ||
      Fail`transcript ${q(kind)} record is missing ${q(key)}`;
  }
  if (kind === 'message') {
    MESSAGE_ROLES.includes(/** @type {string} */ (record.role)) ||
      Fail`transcript message role ${q(record.role)} is not one of ${q(MESSAGE_ROLES)}`;
    if (Object.hasOwn(record, 'providerContext')) {
      const context = /** @type {any} */ (record.providerContext);
      (record.role === 'assistant' &&
        context &&
        Object.keys(context).length === 2 &&
        Object.hasOwn(context, 'format') &&
        Object.hasOwn(context, 'payload') &&
        typeof context.format === 'string' &&
        context.format !== '' &&
        typeof context.payload === 'string' &&
        context.payload !== '') ||
        Fail`Invalid per-message provider context`;
    }
  }
  if (kind === 'tool-result' && Object.hasOwn(record, 'failed')) {
    typeof record.failed === 'boolean' ||
      Fail`transcript tool-result ${q('failed')} must be a boolean`;
  }
  const textFields = fields.filter(
    key =>
      ![
        'kind',
        'failed',
        'role',
        'retainedTail',
        'context',
        'providerContext',
      ].includes(key) && Object.hasOwn(record, key),
  );
  for (const key of textFields) {
    typeof record[key] === 'string' ||
      Fail`transcript ${q(kind)} field ${q(key)} must be a string`;
  }
  if (kind === 'tool-call' || kind === 'tool-result') {
    record.id !== '' || Fail`transcript ${q(kind)} needs a tool call id`;
  }
  if (kind === 'native-context') {
    (record.format !== '' && record.payload !== '') ||
      Fail`native-context format and payload must be nonempty`;
  }
  // Rebuilt in declared field order rather than returned as given, so two
  // records with the same content encode to the same bytes whatever order
  // their producer happened to use.
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const key of fields) {
    // `fields` is the record kind's fixed vocabulary (RECORD_FIELDS); this
    // module runs in the adapter only (no vat program imports it).
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    if (Object.hasOwn(record, key)) ordered[key] = record[key];
  }
  if (kind === 'message' && Object.hasOwn(record, 'providerContext')) {
    const context = /** @type {{format: string, payload: string}} */ (
      record.providerContext
    );
    ordered.providerContext = {
      format: context.format,
      payload: context.payload,
    };
  }
  if (kind === 'compaction' && Object.hasOwn(record, 'retainedTail')) {
    if (!Array.isArray(record.retainedTail)) {
      throw Fail`compaction retainedTail must be an array`;
    }
    ordered.retainedTail = Array.from(record.retainedTail, item => {
      (item?.kind !== 'compaction' && item?.kind !== 'native-context') ||
        Fail`compaction retainedTail must not contain context replacements`;
      return assertTranscriptRecord(item);
    });
  }
  if (kind === 'native-context') {
    if (!Array.isArray(record.context)) {
      throw Fail`native-context context must be an array`;
    }
    ordered.context = Array.from(record.context, (item, index) => {
      item?.kind !== 'native-context' ||
        Fail`native-context must not be nested`;
      if (item?.kind === 'compaction') {
        (index === 0 && !Object.hasOwn(item, 'retainedTail')) ||
          Fail`native-context allows only an initial summary without retainedTail`;
      }
      return assertTranscriptRecord(item);
    });
  }
  return harden(/** @type {TranscriptRecord} */ (ordered));
};
harden(assertTranscriptRecord);

/**
 * Encode one record as a single line, with no trailing newline.
 *
 * @param {unknown} record
 * @returns {string}
 */
export const encodeTranscriptRecord = record =>
  JSON.stringify(assertTranscriptRecord(record));
harden(encodeTranscriptRecord);

/**
 * Encode a whole stream. Every line ends in a newline, including the last, so
 * the file is always in a state another record can be appended to without
 * first reading it.
 *
 * @param {Iterable<unknown>} records
 * @returns {string}
 */
export const encodeTranscript = records => {
  // Lines are collected and joined once (rule 12.4), not appended to a
  // growing string; the bytes are the source's.
  /** @type {string[]} */
  const lines = [];
  for (const record of records) {
    lines.push(encodeTranscriptRecord(record));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};
harden(encodeTranscript);

/**
 * Decode a stream.
 *
 * A trailing partial line — a crash between the write and its newline — is
 * refused rather than silently dropped. Dropping it would turn a torn write
 * into a conversation that quietly lost its last turn, which is precisely the
 * failure this format's line orientation exists to make visible.
 *
 * In a vat, parse only text the harness encoded (see the module note).
 *
 * @param {string} text
 * @returns {TranscriptRecord[]}
 */
export const parseTranscript = text => {
  typeof text === 'string' || Fail`transcript must be text`;
  if (text === '') return harden([]);
  text.endsWith('\n') ||
    Fail`transcript ends mid-record; its last line has no newline`;
  const records = [];
  const lines = text.slice(0, -1).split('\n');
  for (const [index, line] of lines.entries()) {
    line !== '' || Fail`transcript line ${q(index + 1)} is empty`;
    let parsed;
    try {
      // Adapter only (no vat program imports this module; J-9366).
      // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
      parsed = JSON.parse(line);
    } catch (cause) {
      throw Fail`transcript line ${q(index + 1)} is not JSON: ${q(
        /** @type {Error} */ (cause).message,
      )}`;
    }
    records.push(assertTranscriptRecord(parsed));
  }
  return harden(records);
};
harden(parseTranscript);

/**
 * Pair each `tool-call` with its `tool-result` by id, in stream order.
 *
 * Call ids are provider-local and may repeat across turns, so a later call
 * reusing an id must not claim an earlier call's result. Each result is
 * matched to the earliest call of that id that has none yet.
 *
 * A call left unpaired is reported rather than dropped, because a call whose
 * result vanished is a turn that was interrupted and the reader needs to see
 * it that way.
 *
 * Native ids are only meaningful within a turn. A caller replaying to a
 * provider asks for `perTurn`, so an unanswered call stays unanswered when a
 * later turn reuses its id: each user message starts the pairing afresh.
 *
 * @param {readonly TranscriptRecord[]} records
 * @param {{ perTurn?: boolean }} [options]
 */
export const pairToolCalls = (records, { perTurn = false } = {}) => {
  /** @type {Map<string, number[]>} */
  const waiting = new Map();
  /** @type {{ call: TranscriptToolCall, result?: TranscriptToolResult }[]} */
  const pairs = [];
  for (const record of records) {
    if (perTurn && record.kind === 'message' && record.role === 'user') {
      waiting.clear();
    } else if (record.kind === 'tool-call') {
      const queue = waiting.get(record.id) || [];
      queue.push(pairs.length);
      waiting.set(record.id, queue);
      pairs.push({ call: record });
    } else if (record.kind === 'tool-result') {
      const index = waiting.get(record.id)?.shift();
      index === undefined
        ? Fail`transcript tool-result ${q(record.id)} answers no call`
        : (pairs[index].result = record);
    }
  }
  return harden({
    pairs: harden(pairs.map(pair => harden({ ...pair }))),
    unanswered: harden(
      pairs.filter(pair => pair.result === undefined).map(pair => pair.call),
    ),
  });
};
harden(pairToolCalls);
