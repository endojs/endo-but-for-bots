// @ts-check
/**
 * The context projection (M1b W1b.2; architecture D-9, section 4.5;
 * designs/m1b-interfaces.md section 9): session records in, the model's
 * context out, in Node, once per round. The session vat only records; this
 * is the one implementation of "what the model sees", so there is no second
 * one to keep in agreement.
 *
 * Output: transcript records (`guest/lib/transcript-records.js`, the stack's
 * own format every provider adapter translates from): per turn a `message`
 * (`user`, the input), then per round an assistant `message` (the reply
 * text; a round's native context rides along as `providerContext`, replayed
 * from its blob, R4-31), its `tool-call`s and their `tool-result`s in call
 * order (R4-44), whatever order the results were recorded in. A round that
 * ended without `roundFinal` contributes its kept partial text (R4-50).
 *
 * Which turns (R4-32): every turn that reached a provider, including failed,
 * cancelled and outcome-unknown ones (their unknown results already carry
 * `texts.toolOutcomeUnknown`, written by recovery); a turn settled without
 * a `Dispatched` record (never dispatched, `interrupted`) is left out. The
 * turn being run has no `TurnSettled` yet and is always in.
 *
 * M8 (`designs/m8-interfaces.md` 5.5, D-M8-5): a `compaction` record becomes
 * a marker `{ kind: 'compaction', epoch, summary, directive? }` at the end
 * of its turn's output (the hook in `projection-hooks.js` puts the latest
 * summary first and drops every marker); `compaction-started` and
 * `compaction-skipped` project to nothing; a tool result of a turn settled
 * with a status other than `completed` carries `incomplete: true` (R4-32,
 * read by `providers/images.js`); a turn whose `TurnStarted` lies before
 * the records (cut by the boundary) counts as dispatched.
 *
 * Pure: the result depends only on the records (grouped by turn and round)
 * and the texts of their staged fields, so a cache rebuilt from pages
 * projects exactly what the incremental cache does (adapter property test).
 *
 * Adapted from Fae `session/context-transcript.js`, `journal-transcript.js`
 * and `transcript-projection.js` (1315bef86): the eligibility rule, call
 * order and the transcript record kinds are theirs; the journal walking,
 * pet-name records and archive reads are replaced by the session's records.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { isStaged } from '../../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */

/** `providerContext.format` of a replayed native context (opaque payload). */
export const NATIVE_CONTEXT_FORMAT = 'native-context';

/**
 * @typedef {object} Projection
 * @property {readonly any[]} transcript transcript records, model order
 * @property {number} [epoch] the cache's `{ count, epoch }` (context-cache.js)
 * @property {number} [count]
 * @property {string} [input] the full input text of the request's turn
 * @property {{ pages: number, pageMs: number, waitResolveMs: number, readMs: number, blobs: number, projectMs: number }} [timing]
 *   where the cache's prepare spent its time (ms; perf and the context log)
 */

/**
 * @typedef {object} TurnGroup
 * @property {any} started
 * @property {boolean} dispatched
 * @property {boolean} settled
 * @property {boolean} incomplete settled with a status other than
 *   `completed` (R4-32: its image results go as receipts)
 * @property {Map<number, { text?: any, nativeContext?: any, intents?: any[] }>} rounds
 * @property {Map<string, any>} results by op id
 * @property {any[]} markers its `compaction` records (M8)
 */

/**
 * @param {readonly any[]} records session records (log order from the
 *   compaction boundary; a round's results in any order)
 * @param {object} options
 * @param {Map<any, string>} options.texts the text of every staged field
 * @param {readonly import('./projection-hooks.js').ProjectionHook[]} [options.hooks]
 *   run in order over the result (default none: the context cache runs
 *   `projection-hooks.js`'s table once over the sealed part and the tail;
 *   M8's hook imports this module, so this module does not import it)
 * @returns {Projection}
 */
export const projectRecords = (records, { texts, hooks = [] }) => {
  /** @param {any} field */
  const textOf = field => {
    if (!isStaged(field)) return field;
    const text = texts.get(field.blob);
    if (text === undefined) throw Error('context: a staged text is not loaded');
    return text;
  };
  /** turn id -> its group, in start order (a Map keeps insertion order). */
  /** @type {Map<string, TurnGroup>} */
  const turns = new Map();
  for (const record of records) {
    let group = turns.get(record.turnId);
    if (group === undefined) {
      // A turn's first record is its TurnStarted (records.js). A turn cut
      // by the compaction boundary (M8) starts without one: a boundary is
      // a TurnStarted or a later round's RoundSettled (D-M8-4), so a cut
      // turn reached a provider and counts as dispatched.
      group = {
        started: undefined,
        dispatched: record.kind !== 'turn-started',
        settled: false,
        incomplete: false,
        rounds: new Map(),
        results: new Map(),
        markers: [],
      };
      turns.set(record.turnId, group);
    }
    /** @param {number} n */
    const round = n => {
      let found = group.rounds.get(n);
      if (found === undefined) {
        found = {};
        group.rounds.set(n, found);
      }
      return found;
    };
    switch (record.kind) {
      case 'turn-started':
        group.started = record;
        break;
      case 'dispatched':
        group.dispatched = true;
        break;
      case 'turn-settled':
        group.settled = true;
        group.incomplete = record.status !== 'completed';
        break;
      case 'compaction':
        group.markers.push(record);
        break;
      case 'partial': {
        const r = round(record.round);
        if (r.text === undefined) r.text = record.text;
        break;
      }
      case 'round-settled': {
        const r = round(record.round);
        r.text = record.text;
        r.nativeContext = record.nativeContext;
        break;
      }
      case 'tool-intents':
        round(record.round).intents = record.intents;
        break;
      case 'tool-result':
        group.results.set(record.opId, record);
        break;
      default:
        // turn-resolved: an acknowledgement, not dialogue;
        // compaction-started and compaction-skipped: no context (M8).
        break;
    }
  }
  /** @type {any[]} */
  let transcript = [];
  for (const group of turns.values()) {
    // Never-dispatched turns (settled without Dispatched) are left out.
    if (group.dispatched || !group.settled) {
      if (group.started !== undefined) {
        transcript.push({
          kind: 'message',
          role: 'user',
          content: textOf(group.started.input),
        });
      }
      const order = [...group.rounds.keys()].sort((a, b) => a - b);
      for (const n of order) {
        const r = /** @type {any} */ (group.rounds.get(n));
        const content = r.text === undefined ? '' : textOf(r.text);
        const native =
          r.nativeContext === undefined ? '' : textOf(r.nativeContext);
        if (content !== '' || native !== '') {
          /** @type {any} */
          const message = { kind: 'message', role: 'assistant', content };
          if (native !== '') {
            message.providerContext = {
              format: NATIVE_CONTEXT_FORMAT,
              payload: native,
            };
          }
          transcript.push(message);
        }
        const intents = r.intents ?? [];
        for (const intent of intents) {
          transcript.push({
            kind: 'tool-call',
            id: intent.opId,
            name: intent.name,
            args: textOf(intent.args),
          });
        }
        for (const intent of intents) {
          const result = group.results.get(intent.opId);
          if (result !== undefined) {
            /** @type {any} */
            const entry = {
              kind: 'tool-result',
              id: intent.opId,
              content: textOf(result.result),
            };
            if (result.failed) entry.failed = true;
            // M8 (R4-32): a result of a turn that did not complete.
            if (group.incomplete) entry.incomplete = true;
            transcript.push(entry);
          }
        }
      }
    }
    // M8 (D-M8-5): a compaction marker at the end of its turn's output;
    // the projection hook moves the latest summary first.
    for (const marker of group.markers) {
      transcript.push({
        kind: 'compaction',
        epoch: marker.epoch,
        summary: textOf(marker.summary),
        ...(marker.directive === undefined
          ? {}
          : { directive: textOf(marker.directive) }),
      });
    }
  }
  for (const hook of hooks) transcript = hook(transcript, { records, texts });
  return harden({ transcript });
};
harden(projectRecords);
