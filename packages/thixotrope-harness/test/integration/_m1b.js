// @ts-check
/**
 * Helpers shared by the M1b acceptance files (W1b.6): read staged text
 * through the agent host's `Content` (whole blob, in `blobPageBytes`
 * pages), read a turn's full records through `Turn.getContent`, run one
 * turn to its `end` event on a live subscription, and build the transcript
 * the fake provider must have received for one turn, digested exactly as
 * the scripted provider's `context` log line digests it
 * (`contextDigests`), so a test compares what the provider got with text it
 * computed itself. AVA skips files starting with an underscore.
 */
import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { isStaged } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { contextDigests } from '../../resources/agent-host/impl/providers/scripted.js';
import { NATIVE_CONTEXT_FORMAT } from '../../resources/agent-host/impl/projection.js';
import { requestId, waitFor } from './_m1a-slice.js';

export { isStaged };

/**
 * The whole text of a field: itself when inline, else every page of its
 * blob through `Content.read`.
 * @param {any} content the agent host's Content (`E(admin).content()`)
 * @param {any} field a string or a StagedText
 * @returns {Promise<string>}
 */
export const readField = async (content, field) => {
  if (!isStaged(field)) return field;
  /** @type {string[]} */
  const parts = [];
  let offset = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const page = await E(content).read(
      field.blob,
      harden({ offset, maxBytes: limits.blobPageBytes }),
    );
    parts.push(page.text);
    if (page.done) break;
    offset = page.next;
  }
  return parts.join('');
};

/**
 * Every record of a turn, through `Turn.getContent` pages.
 * @param {any} turn a Turn presence
 */
export const turnRecords = async turn => {
  /** @type {any[]} */
  const records = [];
  /** @type {string | undefined} */
  let cursor;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await (cursor === undefined
      ? E(turn).getContent()
      : E(turn).getContent(cursor));
    records.push(...page.records);
    cursor = page.next;
  } while (cursor !== undefined);
  return records;
};

/**
 * Submit `input` and wait for its turn's `end` event on `live`.
 * @param {any} slice from makeSlice
 * @param {any} session
 * @param {ReturnType<import('./_m1a-slice.js').collect>} live
 * @param {string} input
 * @param {number} [ms]
 */
export const runTurn = async (slice, session, live, input, ms = 60_000) => {
  const from = live.deliveries.length;
  const receipt = await E(slice.composer).submit(session, input, requestId());
  const { turnId } = await E(receipt.turn).getStatus();
  const at = await waitFor(
    () =>
      live.deliveries.find(
        (d, i) =>
          i >= from && d.event.type === 'end' && d.event.turnId === turnId,
      ),
    ms,
    `turn "${input.slice(0, 40)}": end`,
    10,
  );
  return { turn: receipt.turn, turnId, end: at.event, from };
};

/**
 * The transcript records of one turn as the projection writes them
 * (`AH/projection.js`), from the turn's own records with every staged
 * field's text supplied by `textOf` (a Map from the field to its text, or
 * read through Content beforehand). Rounds in order; per round the
 * assistant message (with its native context), its calls, then their
 * results in call order.
 * @param {readonly any[]} records the turn's records (`turnRecords`)
 * @param {(field: any) => string} textOf
 */
export const expectedTurnTranscript = (records, textOf) => {
  /** @type {any[]} */
  const out = [];
  const started = records.find(r => r.kind === 'turn-started');
  out.push({ kind: 'message', role: 'user', content: textOf(started.input) });
  /** @type {Map<number, any>} */
  const rounds = new Map();
  /** @param {number} n */
  const round = n => {
    if (!rounds.has(n)) rounds.set(n, {});
    return rounds.get(n);
  };
  /** @type {Map<string, any>} */
  const results = new Map();
  for (const r of records) {
    if (r.kind === 'round-settled') {
      round(r.round).text = r.text;
      round(r.round).nativeContext = r.nativeContext;
    } else if (r.kind === 'partial' && round(r.round).text === undefined)
      round(r.round).text = r.text;
    else if (r.kind === 'tool-intents') round(r.round).intents = r.intents;
    else if (r.kind === 'tool-result') results.set(r.opId, r);
  }
  for (const n of [...rounds.keys()].sort((a, b) => a - b)) {
    const r = rounds.get(n);
    const content = r.text === undefined ? '' : textOf(r.text);
    const native = r.nativeContext === undefined ? '' : textOf(r.nativeContext);
    if (content !== '' || native !== '') {
      /** @type {any} */
      const message = { kind: 'message', role: 'assistant', content };
      if (native !== '')
        message.providerContext = {
          format: NATIVE_CONTEXT_FORMAT,
          payload: native,
        };
      out.push(message);
    }
    for (const intent of r.intents ?? [])
      out.push({
        kind: 'tool-call',
        id: intent.opId,
        name: intent.name,
        args: textOf(intent.args),
      });
    for (const intent of r.intents ?? []) {
      const result = results.get(intent.opId);
      if (result !== undefined) {
        /** @type {any} */
        const entry = {
          kind: 'tool-result',
          id: intent.opId,
          content: textOf(result.result),
        };
        if (result.failed) entry.failed = true;
        out.push(entry);
      }
    }
  }
  return out;
};

/**
 * Read every staged field of `records` through Content; answer a lookup
 * from field to text for `expectedTurnTranscript`.
 * @param {any} content
 * @param {readonly any[]} records
 */
export const loadTexts = async (content, records) => {
  /** @type {Map<any, string>} */
  const texts = new Map();
  /** @param {any} field */
  const visit = async field => {
    if (isStaged(field) && !texts.has(field.blob))
      texts.set(field.blob, await readField(content, field));
  };
  for (const r of records) {
    // eslint-disable-next-line no-await-in-loop
    for (const field of [r.input, r.text, r.nativeContext, r.result])
      // eslint-disable-next-line no-await-in-loop
      await visit(field);
    // eslint-disable-next-line no-await-in-loop
    for (const intent of r.intents ?? []) await visit(intent.args);
  }
  return (/** @type {any} */ field) =>
    isStaged(field)
      ? /** @type {string} */ (texts.get(field.blob))
      : /** @type {string} */ (field);
};

/**
 * The per-turn digest of a turn's transcript (one entry of the context
 * line's `turnDigests`).
 * @param {readonly any[]} transcript
 */
export const turnDigest = transcript => contextDigests(transcript).turnDigests;

/**
 * Lines of kind `context` for one turn and round from a scripted log.
 * @param {any[]} log
 * @param {string} turnId
 * @param {number} round
 */
export const contextLine = (log, turnId, round) =>
  log.filter(
    l => l.kind === 'context' && l.turnId === turnId && l.round === round,
  );
