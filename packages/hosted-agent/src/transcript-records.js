// @ts-check

/**
 * The stack's own record of a hosted conversation, in one format every
 * adapter translates from.
 *
 * A hosted CLI keeps its conversation in a store of its own — OpenCode's
 * SQLite, Claude's JSONL — and until now that store was the record: the
 * adapters declared `continuity: 'transcript'` and revived by resuming it.
 * That makes a guest-writable file the truth, which is why it had to be
 * durable and why it became a mount-table problem. The stack owns the
 * transcript instead, and restores the CLI's native conversation from these
 * records on every revival.
 *
 * Restoration is faithful. A tool call comes back as a tool call with its
 * result, not as prose describing one, because a conversation that reads
 * differently after a restart is a different conversation. Nothing here is
 * wrapped in a preamble telling the model to distrust its own history: these
 * records are written by the harness from the event stream, so they are better
 * evidence than the guest-written store they replace, and the tools a restored
 * call names are authorised by the session's pinned catalog
 * (`mcp-bridge.js`) rather than by anything a transcript claims.
 *
 * The encoding is JSON Lines: one self-describing object per line, no
 * enclosing array. Appending never rewrites a closing character, and a
 * truncated tail costs the last record rather than the file — which matters
 * for a record that is appended to on every turn and read back after a crash.
 *
 * @module
 */

import { Fail, q } from '@endo/errors';

/** Roles a dialogue record may carry. Tool traffic has its own kinds. */
const MESSAGE_ROLES = harden(['user', 'assistant']);

/**
 * The fields each kind carries, in the order they are written. Field order is
 * fixed so the same record always encodes to the same bytes, which is what
 * lets a stream be compared, deduplicated, or hash-chained the way
 * `canonicalAuditJson` chains the audit journal.
 */
const RECORD_FIELDS = harden({
  message: harden(['kind', 'role', 'content']),
  'tool-call': harden(['kind', 'id', 'name', 'args']),
  'tool-result': harden(['kind', 'id', 'content', 'failed']),
  compaction: harden(['kind', 'summary']),
});

/** Fields a kind may omit. Everything else is required. */
const OPTIONAL_FIELDS = harden({
  message: harden([]),
  'tool-call': harden([]),
  'tool-result': harden(['failed']),
  compaction: harden([]),
});

const KINDS = harden(Object.keys(RECORD_FIELDS));

/**
 * @typedef {{ kind: 'message', role: 'user' | 'assistant', content: string }} TranscriptMessage
 * @typedef {{ kind: 'tool-call', id: string, name: string, args: string }} TranscriptToolCall
 * @typedef {{ kind: 'tool-result', id: string, content: string, failed?: boolean }} TranscriptToolResult
 * @typedef {{ kind: 'compaction', summary: string }} TranscriptCompaction
 * @typedef {TranscriptMessage | TranscriptToolCall | TranscriptToolResult | TranscriptCompaction} TranscriptRecord
 */

/**
 * Validate one record.
 *
 * Deliberately narrow: dialogue text, a tool's name and its arguments as the
 * CLI produced them, and nothing else. A record is data the stack wrote about
 * a conversation, never a capability, a path, or a live reference — the same
 * boundary `hosted-continuity.js` drew when it refused to carry "capabilities
 * or tool dispatches", kept here now that the records are structured rather
 * than serialized to a prompt.
 *
 * No size bound. A conversation is restored on every revival until it is
 * deleted, so a record too large to restore would be a conversation the stack
 * had silently stopped owning. Context limits are the CLI's own business and
 * are expressed by a `compaction` record, not by the stack declining to speak.
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
  const fields = RECORD_FIELDS[/** @type {string} */ (kind)];
  const optional = OPTIONAL_FIELDS[/** @type {string} */ (kind)];
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
  }
  if (kind === 'tool-result' && Object.hasOwn(record, 'failed')) {
    typeof record.failed === 'boolean' ||
      Fail`transcript tool-result ${q('failed')} must be a boolean`;
  }
  const textFields = fields.filter(
    key =>
      !['kind', 'failed', 'role'].includes(key) && Object.hasOwn(record, key),
  );
  for (const key of textFields) {
    typeof record[key] === 'string' ||
      Fail`transcript ${q(kind)} field ${q(key)} must be a string`;
  }
  if (kind === 'tool-call' || kind === 'tool-result') {
    record.id !== '' || Fail`transcript ${q(kind)} needs a tool call id`;
  }
  // Rebuilt in declared field order rather than returned as given, so two
  // records with the same content encode to the same bytes whatever order
  // their producer happened to use.
  const ordered = {};
  for (const key of fields) {
    if (Object.hasOwn(record, key)) ordered[key] = record[key];
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
  let text = '';
  for (const record of records) {
    text += `${encodeTranscriptRecord(record)}\n`;
  }
  return text;
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
 * Split a stream at its last compaction.
 *
 * A `compaction` record's position is the boundary: what precedes it is
 * history the model no longer carries, and the record itself plus everything
 * after it is the context it does. This is OpenCode's own model — it selects
 * messages at or after the latest row of type `compaction`
 * (`packages/core/src/session/history.ts`) — and it is the reason the boundary
 * has to be a record rather than something the stack infers. Restore a
 * compacted conversation without it and the whole pre-compaction history
 * becomes active context, which can overflow the model on the first turn
 * after a revival.
 *
 * An adapter whose CLI has no compaction concept can ignore the split and
 * restore `records` whole; one that has it restores `superseded` as history
 * and `active` as the live context.
 *
 * @param {readonly TranscriptRecord[]} records
 * @returns {{ superseded: readonly TranscriptRecord[], active: readonly TranscriptRecord[] }}
 */
export const splitAtLastCompaction = records => {
  let boundary = -1;
  for (const [index, record] of records.entries()) {
    if (record.kind === 'compaction') boundary = index;
  }
  if (boundary < 0) {
    return harden({ superseded: harden([]), active: harden([...records]) });
  }
  return harden({
    superseded: harden(records.slice(0, boundary)),
    active: harden(records.slice(boundary)),
  });
};
harden(splitAtLastCompaction);

/**
 * Pair each `tool-call` with its `tool-result` by id, in stream order.
 *
 * Call ids are provider-local and may repeat across turns, so a later call
 * reusing an id must not claim an earlier call's result. Each result is
 * matched to the earliest call of that id that has none yet — the rule
 * Floot's own `projectHistory` applies when it walks the tree.
 *
 * An adapter uses this to emit native tool traffic; a call left unpaired is
 * reported rather than dropped, because a call whose result vanished is a
 * turn that was interrupted and the CLI needs to see it that way.
 *
 * @param {readonly TranscriptRecord[]} records
 */
export const pairToolCalls = records => {
  /** @type {Map<string, number[]>} */
  const waiting = new Map();
  /** @type {{ call: TranscriptToolCall, result?: TranscriptToolResult }[]} */
  const pairs = [];
  for (const record of records) {
    if (record.kind === 'tool-call') {
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

/**
 * Render records as the conversation they are, for a CLI that cannot be
 * handed a conversation any other way.
 *
 * A conversation is always restored — there is no length at which the stack
 * declines to hand a session its own history — so nothing here truncates or
 * refuses. What the app-server's input channel cannot carry is a tool call as
 * a tool call, so one is written as the line it would read as.
 *
 * @param {readonly TranscriptRecord[]} records
 */
export const renderTranscriptDialogue = records => {
  const lines = [];
  /** @type {Map<string, string>} */
  const calledNames = new Map();
  for (const record of records) {
    if (record.kind === 'message') {
      lines.push(`${record.role}: ${record.content}`);
    } else if (record.kind === 'tool-call') {
      calledNames.set(record.id, record.name);
      lines.push(`assistant called ${record.name}(${record.args})`);
    } else if (record.kind === 'tool-result') {
      const name = calledNames.get(record.id) || 'tool';
      lines.push(`${name} returned: ${record.content}`);
    } else if (record.kind === 'compaction') {
      // Everything above this point was replaced by the summary it carries.
      lines.length = 0;
      lines.push(record.summary);
    }
  }
  return lines.join('\n');
};
harden(renderTranscriptDialogue);

/**
 * Records as raw Responses API items, for a CLI that takes its history that
 * way.
 *
 * A tool call becomes a `function_call` with its `function_call_output`, so a
 * restored call is a call rather than a sentence about one. A call the turn
 * never settled still gets an output saying so: a `function_call` with no
 * answering output is a history the provider will reject, and an interrupted
 * turn has to restore as interrupted rather than as a conversation that
 * cannot load.
 *
 * Everything before the last compaction is dropped. That span is history the
 * model no longer carries, and replaying it would put back the context the
 * compaction removed.
 *
 * @param {readonly TranscriptRecord[]} records
 */
export const responsesApiItems = records => {
  const { active } = splitAtLastCompaction(records);
  const { pairs } = pairToolCalls(active);
  const resultFor = new Map(pairs.map(pair => [pair.call, pair.result]));
  const items = [];
  for (const record of active) {
    if (record.kind === 'message') {
      items.push({
        type: 'message',
        role: record.role,
        content: [
          {
            type: record.role === 'user' ? 'input_text' : 'output_text',
            text: record.content,
          },
        ],
      });
    } else if (record.kind === 'compaction') {
      // The summary opens the span it begins, as the assistant's own words.
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: record.summary }],
      });
    } else if (record.kind === 'tool-call') {
      const result = resultFor.get(record);
      items.push({
        type: 'function_call',
        call_id: record.id,
        name: record.name,
        arguments: record.args,
      });
      items.push({
        type: 'function_call_output',
        call_id: record.id,
        output: result ? result.content : 'Tool call did not complete.',
      });
    }
    // A `tool-result` was emitted with its call above.
  }
  return harden(items);
};
harden(responsesApiItems);

/**
 * Read Responses API items back as records: the inverse of
 * `responsesApiItems`, and what lets the round-trip conformance judge that
 * translation rather than trust it.
 *
 * Reads what the app-server itself reports, not only what this module emits,
 * so a thread the CLI extended after restoration is readable too. A message's
 * text parts are joined; an item kind the stack does not record (reasoning,
 * web-search calls, custom tool calls) is skipped, because there is no record
 * it could faithfully become.
 *
 * @param {readonly any[]} items
 * @returns {readonly TranscriptRecord[]}
 */
export const readResponsesApiItems = items => {
  Array.isArray(items) || Fail`Responses API items must be an array`;
  const records = [];
  for (const item of items) {
    if (item?.type === 'message') {
      const role = item.role === 'user' ? 'user' : 'assistant';
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter(
          part => part?.type === 'input_text' || part?.type === 'output_text',
        )
        .map(part => String(part.text))
        .join('');
      records.push({ kind: 'message', role, content: text });
    } else if (item?.type === 'function_call') {
      records.push({
        kind: 'tool-call',
        id: String(item.call_id),
        name: String(item.name),
        args: String(item.arguments ?? ''),
      });
    } else if (item?.type === 'function_call_output') {
      records.push({
        kind: 'tool-result',
        id: String(item.call_id),
        content:
          typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output ?? ''),
      });
    }
  }
  return harden(records.map(assertTranscriptRecord));
};
harden(readResponsesApiItems);
