// @ts-check
/**
 * The M1a interface contract (milestones.md M1a W1a.0; architecture.md
 * sections 3, 4 and 9; `designs/m1a-interfaces.md` says who calls each method,
 * in which crank, answered or sendOnly, the largest message, and what a
 * retired break from it means), M1b's (W1b.0; `designs/m1b-interfaces.md`)
 * and M2's (W2.0; `designs/m2-interfaces.md`).
 *
 * Tables (M2 W2.0 folded M1b's into M1a's): `shapes`, `interfaces` and
 * `methodNames` hold every M1a, M1b and M2 entry; where M1b extended an M1a
 * interface the table holds the M1b version. `m1bShapes`, `m1bInterfaces`
 * and `m1bMethodNames` remain as views of the M1b names over the folded
 * tables (the same objects), for modules written against them.
 * `m2Interfaces` and `m2MethodNames` hold the M2 versions of the interfaces
 * M2 extends: the unit that implements an M2 method switches that exo from
 * `interfaces.X` to `m2Interfaces.X` (m2-interfaces.md 1.3). Interfaces new
 * in M2 are in `interfaces` directly.
 *
 * Every object that crosses between M1a's units has its `M.interface` guard
 * here; every record that crosses has a closed `M.splitRecord` shape with a
 * fixed key vocabulary (rule 12.10: a fresh record key costs a vat one of its
 * ~57,000 names for life); every string and array is bounded from
 * `limits.js`. Model and tool JSON crosses as text, never as a record.
 *
 * A guard does not protect a vat from an oversize frame or from fresh record
 * keys (decoding happens before the guard runs); senders check sizes first
 * (`bounded.js`, rule 12.5) and the gateway checks keys against these shapes
 * (architecture section 7).
 *
 * Runs in vats (prelude globals) and in Node: a Node process must install the
 * guest prelude on `globalThis` before importing this module
 * (`scripts/guest-prelude.js` `installGuestPrelude()`; tests import
 * `test/unit/_m1a-prelude.js` first).
 *
 * Changing an existing guard is a contract change (commit subject
 * `contract(thixotrope-harness): ...`, m1a-interfaces.md updated in the same
 * commit). Later milestones add methods and optional record keys; they never
 * remove or narrow one another unit relies on.
 */
import { limits } from './limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);
if (M === undefined) {
  throw TypeError(
    'guest/lib/interfaces.js needs the guest prelude on globalThis; in Node call installGuestPrelude() from scripts/guest-prelude.js before importing it',
  );
}

// ---------------------------------------------------------------- helpers

/** @type {Map<number, any>} */
const textShapes = new Map();
/**
 * A string of at most `units` UTF-16 units (one matcher per bound).
 * @param {number} units
 */
const text = units => {
  if (!textShapes.has(units)) {
    textShapes.set(units, M.string({ stringLengthLimit: units }));
  }
  return textShapes.get(units);
};
/**
 * @param {any} shape
 * @param {number} length
 */
const list = (shape, length) => M.arrayOf(shape, { arrayLengthLimit: length });
/**
 * A closed record: these keys and no others. `M.splitRecord` admits any
 * further keys unless its rest pattern is given; the empty record as rest
 * refuses them (rule 12.10).
 * @param {Record<string, any>} required
 * @param {Record<string, any>} [optional]
 */
const record = (required, optional = {}) =>
  M.splitRecord(required, optional, {});

/** Non-negative number: times in ms, counts, rounds, revisions. */
const count = M.and(M.number(), M.gte(0));

/**
 * M1b: an inline text field (at most `inlineBytes` from M1b on, checked by
 * the sender) or the StagedText that replaces it when larger (D-10, D-15).
 * Called inside lazy builders only (`B` is defined below).
 * @param {any} inline
 */
const staged = inline => M.or(inline, B.StagedText);

/**
 * A hardened record whose properties are built on first read and then kept.
 * Building every guard eagerly costs a vat about 0.55-0.7 s in its loading
 * crank (each `M.interface` about 25 ms, each `M.string` or `M.splitRecord`
 * about 1-1.5 ms; W1a.0 vat probe, JOURNAL J-0201), and most vats use a few.
 * @template {Record<string, () => any>} T
 * @param {T} builders
 * @returns {{ readonly [K in keyof T]: ReturnType<T[K]> }}
 */
const lazyTable = builders => {
  /** @type {Map<string, any>} */
  const built = new Map();
  /** @type {any} */
  const table = {};
  for (const [name, build] of Object.entries(builders)) {
    // The names are this module's own table keys, fixed in its source.
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    Object.defineProperty(table, name, {
      enumerable: true,
      get: () => {
        if (!built.has(name)) built.set(name, build());
        return built.get(name);
      },
    });
  }
  return harden(table);
};

/**
 * A hardened view of some names of a lazy table: each property reads the
 * table's (the same object). The M1b tables are such views since M2 W2.0
 * folded them into the main tables.
 * @param {readonly string[]} names
 * @param {any} table
 */
const viewOf = (names, table) => {
  /** @type {any} */
  const view = {};
  for (const name of names) {
    // The names are this module's own table keys, fixed in its source.
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    Object.defineProperty(view, name, {
      enumerable: true,
      get: () => table[name],
    });
  }
  return harden(view);
};

// ---------------------------------------------------------------- texts

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
export const texts = harden({
  /** R4-10 (SPEC:463, A.4 startTurn). */
  activeTurn: 'Session already has an active turn; observe or cancel it first',
  /** R4-47: the turn ends normally with this final text at the round limit. */
  roundLimit:
    "I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again?",
  /** R4-66: a turn provably never sent to a backend. */
  interruptedBeforeDispatch:
    'Interrupted before dispatch; no backend execution was started.',
  /** R4-32 / R4-66: the result of a tool intent whose outcome a restart hid. */
  toolOutcomeUnknown: 'Tool outcome unknown; do not automatically retry.',
  /**
   * Harness (M1a W1a.2): a message into a vat would exceed frameBytes; the
   * round or tool call fails with this reason before anything is sent.
   */
  frameLimit: "round output exceeds this build's frame limit",
  /** R4-42: a provider tool call without a name, or a non-string id. */
  invalidToolCall: 'Invalid provider tool call',
  /** R4-42: two calls with the same id in one model response. */
  duplicateToolCallId:
    'Provider returned a duplicate tool call ID within one response',
  /** A.4 queue holds (SPEC:1621-1625). */
  holdRestart:
    'These messages were queued before the service restarted. Nothing is sent until you send one.',
  holdStopped:
    'The session was stopped with messages queued. Nothing is sent until you send one.',
  holdInterrupted:
    'The service restarted while this message was being sent, so it may or may not have reached the agent. Check the conversation, then send it again or delete it.',
  /** A.4 hold `refused` when the turn gave no error. */
  holdRefusedDefault: 'Not sent: the turn ended before it started',
  /** R4-55 / A.4 request ids (Fae pending-queue.js:301-334). */
  invalidRequestId: 'Invalid submission request ID',
  requestIdExpired:
    'Submission retry window expired or device clock is incorrect',
  requestIdReused: 'Submission request ID already used for different text',
  receiptLimit:
    'Submission receipt limit reached; wait for the retry window to expire',
  /** R4-6, adapted to object passing (Endo: "use backendId and modelId"). */
  modelOption:
    'createSession option "model" is unsupported; use backend and modelId',
  /** Turn.resolve on a turn whose outcome is known. */
  resolveNotUnknown: 'Only a turn whose outcome is unknown can be resolved',
  /** A history cursor this session did not issue. */
  badCursor: 'Unknown history cursor',
  /** findSession with a key the factory does not know. */
  unknownSession: 'Unknown session',
  /** createSession without a backend (M1a has no factory default). */
  noBackend: 'No backend given and no default backend is configured',
  /** createSession with a blank systemPrompt (R4-27). */
  blankSystemPrompt: 'createSession systemPrompt must be a nonblank string',
  /** QueueEntry.describe on an entry that was claimed or cancelled. */
  entryGone: 'This message is no longer waiting',
  /** Backend.open with a SessionHostFacet the manager did not mint. */
  unknownSessionHost: 'Unknown session host',
  /**
   * enqueueOnce or startTurn with empty or whitespace-only text. The spec
   * names the refusal (Fae trims and refuses) but gives no text; this is
   * Fae's (`packages/fae/session/pending-queue.js:49-53` at `1315bef86`,
   * JOURNAL J-0253, J-9150).
   */
  blankSubmission: 'A queued message must be non-empty text',
  /** Turn.resolve on a turn that was already resolved (one TurnResolved per turn). */
  turnAlreadyResolved: 'This turn was already resolved',

  // ---- M1b (m1b-interfaces.md section 13) ----
  /**
   * Architecture 6: the exec vat halted or was given up (the session cannot
   * tell which, J-9051); the vat is retired.
   */
  execTerminated:
    'exec scope terminated: the exec vat stopped (it exceeded the per-step compute budget or its worker failed repeatedly); bindings from earlier calls are gone',
  /** Architecture 6: the exec vat answered busy; it was retired. */
  execBusyReset:
    'the previous exec call was still running; the scope was reset',
  /** R3-41 (Fae tool-makers.js:1650 at 1315bef86): `exec` returned undefined. */
  execNoReturn:
    'done (no return value). Use a top-level return to produce a result (for example: return await E(powers).list();). Final expressions and unreturned nested functions do not return a result; console output goes to daemon logs. Any effects already performed still happened: do not repeat them just to obtain output.',
  /** Fae tool-makers.js:1617: empty `code`. */
  execCodeRequired: 'code is required',
  /** Harness (R4-49): the turn was cancelled while its exec call ran. */
  execAbandoned:
    'exec call abandoned: the turn was cancelled while it ran; the code may still be running and its effects may still happen',
  /**
   * M1b QC (J-0333, J-0390): the exec vat ran out of property names (its
   * name table is per vat and never shrinks; the engine's RangeError is
   * catchable, so the vat does not halt). The exec vat answers
   * `{ status: 'exhausted' }`; the session retires the scope.
   */
  execExhausted:
    'exec scope terminated: the exec vat ran out of property names (too many distinct keys were created); bindings from earlier calls are gone',
  /** Content.read with a handle that has no file. */
  blobUnknown: 'Unknown blob',
  /**
   * M1b follow-ups (J-9364): a handle that was staged for another session
   * (`Content.read` through a session's ports, or a staged field in a
   * session's records that names another session's blob).
   */
  blobNotOwned: 'This blob belongs to another session',
  /** BlobWriter.append or close after close or abort. */
  writerClosed: 'This blob writer is closed',

  // ---- M2 (m2-interfaces.md section 14) ----
  /**
   * R4-77 (Fae providers/anthropic-streaming.js:170 at 1315bef86): a 401
   * from the Anthropic API.
   */
  anthropicAuthFailed:
    'Anthropic API authentication failed (invalid or expired API key). Check the configured Secret.',
  /**
   * R4-78 (lal providers/openrouter.js:515): appended, after a blank line,
   * to a reply the model cut at its own output limit.
   */
  outputLimitNote: '[The model stopped here: it reached its own output limit.]',
  /** R4-74 (lal providers/openrouter.js:337): network failure or unreadable answer. */
  openRouterUnreachable:
    'OpenRouter could not be reached or sent an unreadable response',
  /** R4-21 (Fae session/provider-connections.js:546): OpenRouter ids are `org/model`. */
  openRouterModelPrefix:
    'OpenRouter model must include its organization prefix',
  /** A.4 creation error (Fae session/provider-connections.js:590). */
  catalogUnavailable:
    'Model catalog unavailable for the provider backend; no model can be admitted now',
  /**
   * Harness (R4-21: no backend but the factory's default accepts an empty
   * model; the spec gives no text): a creation on another backend without
   * a model, or on an API backend that has no configured model.
   */
  modelRequired: 'A model must be chosen for this backend',
  /**
   * Harness (R4-79: no provider body in failure text): the Anthropic API
   * could not be reached or answered something unreadable (OpenRouter's
   * wording, R4-74).
   */
  anthropicUnreachable:
    'Anthropic API could not be reached or sent an unreadable response',
  /** Harness (R4-9): a session being deleted takes no new work. */
  sessionDeleting: 'This session is being deleted',
  /**
   * Harness (D-M2-1, m2-interfaces.md 4.9): `Turn.getContent` or
   * `Session.findTurn` of a turn whose records were sealed into the
   * archive; read it through the agent host's `History`.
   */
  turnSealed: 'This turn is archived; read it through the history service',
  /**
   * Harness (m2-interfaces.md 4.6): `Turn.resolve` of an archived
   * outcome-unknown turn the session no longer keeps (more than
   * `maxUnresolvedTurns` were waiting).
   */
  turnArchivedUnresolvable:
    'This turn is archived and can no longer be resolved',
  /**
   * Harness (m2-interfaces.md 4.8): a `ContextSource` cursor below the
   * session's sealed boundary.
   */
  recordsSealed: 'These records are archived',
  /** Harness: `Session.findTurn` with an id this session never minted. */
  unknownTurn: 'Unknown turn',
});

/**
 * The record kind letters of `SealRequest.kinds` (m2-interfaces.md 4.4),
 * by record kind; the adapter checks its copy of the range against them.
 */
export const archiveKindLetters = harden([
  ['turn-started', 's'],
  ['dispatched', 'd'],
  ['partial', 'p'],
  ['round-settled', 'r'],
  ['tool-intents', 'i'],
  ['tool-result', 't'],
  ['turn-settled', 'e'],
  ['turn-resolved', 'v'],
]);

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  /**
   * R4-43 (Fae src/tools.js:160).
   * @param {string} name
   * @param {readonly string[]} available
   */
  unknownTool: (name, available) =>
    `Unknown tool: "${name}". Available tools: ${available.join(', ')}`,
  /**
   * R4-43 (Fae src/tool-arguments.js:20).
   * @param {string} key
   * @param {string} tool
   * @param {readonly string[]} allowed
   */
  unexpectedArgument: (key, tool, allowed) =>
    `Unexpected argument ${JSON.stringify(key)} for ${tool}; allowed arguments: ${allowed.join(', ') || '(none)'}`,
  /**
   * R4-45 (Fae session-factory.js:1091).
   * @param {string} parseError the parser's message
   */
  argumentsNotJson: parseError =>
    `could not parse tool arguments as JSON (${parseError}). Re-send this tool call with valid JSON arguments.`,
  /**
   * R4-45: a thrown error becomes this result, marked failed.
   * @param {string} message
   */
  errorResult: message => `Error: ${message}`,
  /**
   * R4-46: appended to a cut tool output (Fae session/tool-output.js:18).
   * @param {number} originalUnits the untruncated length in UTF-16 units
   */
  truncationMarker: originalUnits =>
    `\n[Tool output truncated from ${originalUnits} characters. Only a prefix is shown; use filtering or pagination for more.]`,
  /**
   * Architecture 4.1: calls beyond maxCallsPerRound get this failed result.
   * @param {number} calls
   * @param {number} limit
   */
  tooManyCalls: (calls, limit) =>
    `Too many tool calls in one round (${calls}); only the first ${limit} were run.`,
  /**
   * R4-53 / A.4 capacity.
   * @param {number} limit
   */
  queueFull: limit =>
    `This session already has ${limit} messages waiting; send or delete some first`,
  /**
   * A.4 hold `refused`.
   * @param {string} error
   */
  holdRefused: error => `Not sent: ${error}`,
  /**
   * A.4 hold `unavailable`.
   * @param {string} error
   */
  holdUnavailable: error => `Queued messages cannot be read: ${error}`,
  /**
   * R4-42: the id given to a provider tool call that has none.
   * @param {number} round
   * @param {number} index
   */
  synthesizedCallId: (round, index) => `floot-synth-${round}-${index}`,
  /**
   * Composer (M1a, no staging): a submission over inlineBytes.
   * @param {number} bytes
   * @param {number} limit
   */
  submissionTooLarge: (bytes, limit) =>
    `message too large (${bytes} bytes; this build accepts at most ${limit})`,
  /**
   * createSession options M1a does not implement yet.
   * @param {string} name
   */
  optionNotSupported: name =>
    `createSession option "${name}" is not supported yet`,
  /**
   * Backend.open failed (any error, including a retired break from the
   * manager vat, which is a guest vat: that vat is lost, not a restart).
   * @param {string} message
   */
  openFailed: message => `Could not open the backend: ${message}`,
  /**
   * The scripted provider has no round with this index for the turn.
   * @param {number} round
   */
  scriptExhausted: round => `Script has no round ${round} for this turn`,
  /**
   * A built-in tool argument of the wrong type (adapter tools, e.g. echo).
   * @param {string} name
   * @param {string} tool
   * @param {string} expected e.g. 'a string', 'a non-negative number'
   */
  invalidArgument: (name, tool, expected) =>
    `Invalid argument ${JSON.stringify(name)} for ${tool}: expected ${expected}`,
  /**
   * Op ids (architecture 8): turn id, round, call ordinal within the round.
   * @param {string} turnId
   * @param {number} round
   * @param {number} ordinal
   */
  opId: (turnId, round, ordinal) => `${turnId}/r${round}/c${ordinal}`,

  // ---- M1b ----
  /**
   * Architecture 6: the exec deadline fired; the vat was retired.
   * @param {number} ms
   */
  execTimeout: ms =>
    `exec call timed out after ${ms} ms; the exec vat was stopped and the scope was reset; bindings from earlier calls are gone`,
  /**
   * Architecture 6: exec arguments over execSourceBytes.
   * @param {number} bytes
   * @param {number} limit
   */
  execSourceTooLarge: (bytes, limit) =>
    `exec source too large (${bytes} bytes; limit ${limit})`,
  /**
   * ExecHandle.scope failed (the factory could not provide an exec vat).
   * @param {string} message
   */
  execUnavailable: message => `exec is unavailable: ${message}`,
  /**
   * Staging failed (blob store or manager); the round or submission fails.
   * @param {string} message
   */
  stagingFailed: message => `could not stage large text: ${message}`,
  /**
   * M1b follow-ups (J-9369; M1a QC advisory J-0296 (7)): an inline
   * submission whose UTF-8 bytes exceed `inlineBytes` (the guard bounds
   * units only, so up to about 24.6 KB passed); the Composer stages such
   * text, so only a caller that skips it meets this.
   * @param {number} bytes
   * @param {number} limit
   */
  inlineTooLarge: (bytes, limit) =>
    `Inline text of ${bytes} bytes is over the ${limit}-byte limit; larger text must be staged (the Composer does this)`,
  /**
   * M1b follow-ups (J-9361): a staging that would take a session's staged
   * text on disk over its quota (`blobLimits.sessionBytes`); the message of
   * the staging failure (`stagingFailed`).
   * @param {number} bytes the text being staged
   * @param {number} held bytes the session already has staged
   * @param {number} quota
   */
  blobSessionQuota: (bytes, held, quota) =>
    `the session's staged text would exceed its disk quota: ${bytes} more bytes on top of ${held}, quota ${quota} bytes`,
  /**
   * M1b follow-ups (J-9361): a staging that would take all staged text on
   * this daemon's disk over the daemon-wide quota (`blobLimits.daemonBytes`).
   * @param {number} bytes
   * @param {number} held bytes staged on this daemon's disk
   * @param {number} quota
   */
  blobDaemonQuota: (bytes, held, quota) =>
    `the daemon's staged text would exceed its disk quota: ${bytes} more bytes on top of ${held}, quota ${quota} bytes`,

  // ---- M2 (m2-interfaces.md section 14) ----
  /**
   * R4-74 (lal providers/openrouter.js:359): a non-2xx answer.
   * @param {number} status
   */
  openRouterHttp: status => `OpenRouter request failed (HTTP ${status})`,
  /**
   * R4-74, R4-93 (lal providers/openrouter.js:335): the request timeout.
   * @param {number} seconds
   */
  openRouterTimeout: seconds =>
    `OpenRouter did not answer within ${seconds} seconds`,
  /**
   * R4-74 (lal providers/openrouter.js:437-441): the last failure after
   * retries.
   * @param {string} failure
   * @param {number} attempts
   */
  afterAttempts: (failure, attempts) =>
    attempts > 1 ? `${failure}, after ${attempts} attempts` : failure,
  /**
   * R4-78 (lal providers/openrouter.js:458, 471): content filtering, or a
   * length stop with no text. `served` is `textOf.servedBy(...)` or ''.
   * @param {'content_filter' | 'length'} reason
   * @param {string} served
   */
  openRouterStopped: (reason, served) =>
    `OpenRouter completion stopped: ${reason}${served}`,
  /**
   * R4-78 (lal providers/openrouter.js:497): an answer with neither text
   * nor tool calls. `details` as `served`.
   * @param {string} details
   */
  openRouterEmpty: details =>
    `OpenRouter returned an empty assistant response${details}`,
  /**
   * R4-79 (lal providers/openrouter.js:379): an `error` object in the
   * answer (W2.1a: in a stream chunk). `details` as `served`, with the
   * error's code when it has an identifier's shape.
   * @param {string} details
   */
  openRouterApiError: details => `OpenRouter returned an API error${details}`,
  /**
   * R4-79 (lal providers/openrouter.js:394): no choice, or a choice that
   * finished with `error`. `details` as `served`.
   * @param {string} details
   */
  openRouterNoMessage: details =>
    `OpenRouter returned no successful assistant message${details}`,
  /**
   * The parenthesised detail of OpenRouter failures (lal
   * providers/openrouter.js:148-156): ` (served by m, via p)`, or ''.
   * Values are the provider's model and provider names only, never a body.
   * @param {readonly [string, string][]} parts label and value pairs
   */
  servedBy: parts =>
    parts.length === 0
      ? ''
      : ` (${parts.map(([label, value]) => `${label} ${value}`).join(', ')})`,
  /**
   * Harness (R4-79): an Anthropic API answer other than 2xx or 401.
   * @param {number} status
   */
  anthropicHttp: status => `Anthropic API request failed (HTTP ${status})`,
  /**
   * Harness (G-04, R4-93): the Anthropic request timeout.
   * @param {number} seconds
   */
  anthropicTimeout: seconds =>
    `Anthropic API did not answer within ${seconds} seconds`,
  /**
   * Harness (R4-78, R4-79; OpenRouter's wording): a stop the round cannot
   * deliver (`max_tokens` without text or inside a tool call, `refusal`, an
   * unknown stop reason). `reason` is the API's stop reason when it has an
   * identifier's shape, else `unknown`.
   * @param {string} reason
   */
  anthropicStopped: reason => `Anthropic API completion stopped: ${reason}`,
  /**
   * Harness (R4-79): an `error` event in the stream (`overloaded_error`,
   * `api_error`, ...). `details` is `textOf.servedBy([['type', t]])` or ''.
   * @param {string} details
   */
  anthropicApiError: details => `Anthropic API returned an error${details}`,
  /**
   * Harness (R4-42: on Claude the stop reason must agree with the presence
   * of tool calls; the Fae text was not available to this build).
   * @param {string} reason the stop reason (identifier-shaped or `unknown`)
   * @param {number} calls tool calls in the answer
   */
  anthropicStopMismatch: (reason, calls) =>
    `Anthropic API stop reason ${reason} does not match the ${calls} tool calls of its answer`,
  /**
   * A.4 creation error (Fae session/provider-connections.js:600).
   * @param {string} modelId
   */
  unknownProviderModel: modelId =>
    `Unknown model "${modelId}" for the provider backend`,
  /**
   * R7-24 (daemon secret-manager.js:27 at 1315bef86): every Secrets
   * failure is one of the fixed codes (`secretCodes`), never secret bytes.
   * @param {string} code
   */
  secretFailed: code => `Secret operation failed: "${code}"`,
  /**
   * Harness (R4-48 departure, G-06; m2-interfaces.md 10): the turn deadline
   * (`turnDeadlineMs`, off by default) fired.
   * @param {number} ms
   */
  turnDeadline: ms =>
    `The turn ran longer than its ${ms} ms deadline and was stopped`,
  /**
   * The op id of a turn's deadline timer (architecture 8).
   * @param {string} turnId
   */
  turnDeadlineOpId: turnId => `${turnId}/deadline`,
  /**
   * Harness (m2-interfaces.md 4.4): sealing failed; nothing was dropped and
   * the session seals again later. Also the failure of an archive read.
   * @param {string} message
   */
  archiveFailed: message => `could not archive turns: ${message}`,
  /**
   * M2 switching rule (m2-interfaces.md 1.3): an M2 method whose unit has
   * not built it yet. Nothing may answer with this after W2.9.
   * @param {string} method
   */
  notBuilt: method => `not built yet: ${method}`,
});

/**
 * R7-24 (daemon secret-manager.js at 1315bef86): the fixed codes of
 * Secrets failures and audit events; `textOf.secretFailed(code)`.
 */
export const secretCodes = harden([
  'INVALID_DESCRIPTION',
  'INVALID_SECRET_BYTES',
  'UNKNOWN_SECRET',
  'UNKNOWN_GRANT',
  'REVOKED',
  'STALE_READ',
  'READ_FAILED',
  'INVALID_GENERATION',
  'GENERATION_CONFLICT',
  'REPLACE_FAILED',
  'NOT_REVOKED',
  'DELETE_FAILED',
  'INVALID_LIMIT',
  'CREATE_FAILED',
]);

// ---------------------------------------------------------------- shapes

/**
 * M1a's shapes (W1a.0), widened in place by M1b (`staged(...)`) and M2
 * (optional fields; m2-interfaces.md 1.4). `shapes` below holds them with
 * M1b's and M2's.
 */
const m1aShapeBuilders = {
  Id: () => text(limits.idUnits),
  Label: () => text(limits.labelUnits),
  Reason: () => text(limits.reasonUnits),
  Text: () => text(limits.textUnits),
  SubmissionText: () => text(limits.submissionUnits),
  ToolName: () => text(limits.toolNameUnits),
  ModelId: () => text(limits.modelIdUnits),
  Cursor: () => text(limits.cursorUnits),
  /** Turn states. `running` and `cancelling` are live; the rest are settled. */
  TurnState: () =>
    M.or(
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'outcome-unknown',
      'interrupted',
    ),
  /** Statuses a TurnSettled record can carry. */
  SettledStatus: () =>
    M.or('completed', 'failed', 'cancelled', 'outcome-unknown', 'interrupted'),
  Phase: () =>
    M.or('thinking', 'using tools', 'compacting context', 'cancelling'),
  Activity: () => M.or('passive', 'working', 'error'),
  // M2: `deleting` while deleteSession runs (R4-9; m2-interfaces.md 7).
  Lifecycle: () => M.or('creating', 'ready', 'error', 'lost', 'deleting'),
  HoldReason: () =>
    M.or('restart', 'stopped', 'refused', 'interrupted', 'unavailable'),
  ContextReading: () => record({ usedTokens: count, windowTokens: count }),
  /** One model request's token counts (hosted-agent token-usage.js; R4-33). */
  Usage: () =>
    record(
      {
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        cacheWriteInputTokens: count,
        reasoningOutputTokens: count,
      },
      { context: S.ContextReading },
    ),
  /** Session totals (A.4 getUsage, event `usage`; R4-83). */
  UsageTotals: () =>
    record(
      {
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        cacheWriteInputTokens: count,
        reasoningOutputTokens: count,
        context: S.ContextReading,
        turns: count,
        incompleteTurns: count,
      },
      {},
    ),
  /** A user submission: inline text, or (M1b) a StagedText over inlineBytes. */
  Submission: () => M.or(record({ text: S.SubmissionText }), B.StagedText),
  /** A tool call as the model returned it; `args` is the model's JSON text (or staged). */
  ToolCall: () =>
    record({
      callId: text(limits.callIdUnits),
      name: S.ToolName,
      args: staged(S.Text),
    }),
  /** One tool intent: a ToolCall with the op id the session assigned. */
  ToolIntent: () =>
    record({
      opId: S.Id,
      callId: text(limits.callIdUnits),
      name: S.ToolName,
      args: staged(S.Text),
    }),
  /** A tool as offered to the model; `parameters` is JSON Schema as text. */
  ToolDescription: () =>
    record({
      name: S.ToolName,
      description: text(limits.toolDescriptionUnits),
      parameters: text(limits.toolParametersUnits),
    }),
  /** Who served a round (R4-50, R4-108). */
  // M2 W2.1a: OpenRouter also names the upstream provider (R4-108).
  ServedBy: () =>
    record({ label: S.Label, modelId: S.ModelId }, { provider: S.Label }),
  TurnStarted: () =>
    record({
      kind: 'turn-started',
      turnId: S.Id,
      input: staged(S.SubmissionText),
      at: count,
    }),
  Dispatched: () => record({ kind: 'dispatched', turnId: S.Id, round: count }),
  Partial: () =>
    record({
      kind: 'partial',
      turnId: S.Id,
      round: count,
      text: staged(S.Text),
    }),
  RoundSettled: () =>
    record(
      {
        kind: 'round-settled',
        turnId: S.Id,
        round: count,
        text: staged(S.Text),
        callCount: count,
        usage: S.Usage,
        at: count,
      },
      { servedBy: S.ServedBy, nativeContext: B.StagedText },
    ),
  ToolIntents: () =>
    record({
      kind: 'tool-intents',
      turnId: S.Id,
      round: count,
      intents: list(S.ToolIntent, limits.maxCallsPerMessage),
    }),
  ToolResult: () =>
    record(
      {
        kind: 'tool-result',
        turnId: S.Id,
        opId: S.Id,
        name: S.ToolName,
        result: staged(text(limits.toolOutputUnits)),
        failed: M.boolean(),
      },
      { outcome: 'unknown' },
    ),
  TurnSettled: () =>
    record(
      {
        kind: 'turn-settled',
        turnId: S.Id,
        status: S.SettledStatus,
        at: count,
      },
      { error: S.Reason, final: staged(S.Text), usage: S.Usage },
    ),
  TurnResolved: () =>
    record({
      kind: 'turn-resolved',
      turnId: S.Id,
      note: S.Reason,
      at: count,
    }),
  /** Any turn record. */
  TurnRecord: () =>
    M.or(
      S.TurnStarted,
      S.Dispatched,
      S.Partial,
      S.RoundSettled,
      S.ToolIntents,
      S.ToolResult,
      S.TurnSettled,
      S.TurnResolved,
    ),
  // ---- adapter <-> session turn traffic ----

  /** `Endpoint.startRound` argument (architecture 4.1, D-9). */
  RoundRequest: () =>
    record(
      {
        turn: M.remotable('Turn'),
        sink: M.remotable('TurnSink'),
        turnId: S.Id,
        round: count,
        // M2: `archive` once the session has sealed segments (D-M2-1;
        // m2-interfaces.md 4.8): records before `archive.sealedTo` are
        // in the archive, not in the vat.
        base: record({ count, epoch: count }, { archive: S.ArchiveState }),
        append: list(S.TurnRecord, limits.maxAppendRecords),
        tools: list(S.ToolDescription, limits.maxToolsPerRound),
        options: record(
          { modelId: S.ModelId },
          { reasoningEffort: text(limits.effortUnits), maxOutputTokens: count },
        ),
      },
      // M2: `system` may be staged (a composed prompt over inlineBytes).
      { context: M.remotable('ContextSource'), system: staged(S.Text) },
    ),
  /** `TurnSink.roundFinal` argument. */
  RoundResult: () =>
    record(
      {
        round: count,
        text: staged(S.Text),
        toolCalls: list(S.ToolCall, limits.maxCallsPerMessage),
        usage: S.Usage,
        at: count,
      },
      { servedBy: S.ServedBy, nativeContext: B.StagedText },
    ),
  /** `TurnSink.roundFailed` argument; `partial` is the text streamed so far. */
  RoundFailure: () =>
    record(
      { round: count, reason: S.Reason, at: count },
      { partial: staged(S.Text), usage: S.Usage },
    ),
  /** What `Backend.open(host)` returns: one adapter incarnation's turn ports. */
  AdapterToolEntry: () =>
    record({
      name: S.ToolName,
      tool: M.remotable('AdapterTool'),
    }),
  /**
   * `since`: when the adapter incarnation that minted these ports started
   * (ms since the epoch, the adapter's clock). The session holds its ports
   * across turns and compares a turn's claim time with the `since` of fresh
   * ports to tell a turn in flight at a restart from one claimed on ports
   * that were already dead (m1a-interfaces.md 6.1, 7).
   */
  TurnPorts: () =>
    record(
      {
        endpoint: M.remotable('Endpoint'),
        publisher: M.remotable('LivePublisher'),
        tools: list(S.AdapterToolEntry, limits.maxToolsPerRound),
        since: count,
      },
      // M1b: what the exec vat is handed per call (m1b-interfaces.md 3.2).
      {
        content: M.remotable('Content'),
        writers: M.remotable('BlobWriters'),
        timer: M.remotable('Timer'),
        // M2 (D-M2-1): this session's archive port in this incarnation.
        archive: M.remotable('ArchivePort'),
      },
    ),
  /** `AdapterTool.execute` argument; M1b: `args` may be staged (W1b.1, 6.4). */
  ToolRequest: () => record({ opId: S.Id, args: staged(S.Text) }),
  /**
   * A tool outcome (adapter tools and the vat's tool-table entries alike).
   * `failed`: `text` is the error message (the session writes `Error: <text>`).
   * `frame-limit`: `text` is `texts.frameLimit`; the round fails after its
   * other calls settle. M1b: `text` may be a StagedText (m1b-interfaces.md 5).
   */
  ToolOutcome: () =>
    record({
      status: M.or('ok', 'failed', 'frame-limit'),
      text: staged(text(limits.toolOutputUnits)),
    }),
  Hold: () => record({ reason: S.HoldReason, message: S.Reason }),
  PendingRow: () =>
    record({
      entry: M.remotable('QueueEntry'),
      key: S.Id,
      preview: text(limits.messagePreviewUnits),
      state: 'queued',
      at: count,
    }),
  PendingView: () =>
    record(
      { entries: list(S.PendingRow, limits.maxWaiting) },
      { hold: S.Hold },
    ),
  EntryInfo: () =>
    record({
      key: S.Id,
      preview: text(limits.messagePreviewUnits),
      state: 'queued',
      at: count,
    }),
  Receipt: () =>
    record(
      {
        requestId: text(limits.requestIdUnits),
        duplicate: M.boolean(),
        state: M.or('queued', 'started'),
      },
      // M2: a started receipt of an archived turn names it by `turnId`
      // only (m2-interfaces.md 5.3).
      {
        entry: M.remotable('QueueEntry'),
        turn: M.remotable('Turn'),
        turnId: S.Id,
      },
    ),
  PresetSnapshot: () => record({ label: S.Label }),
  SessionInfo: () =>
    record(
      {
        key: S.Id,
        title: text(limits.titleUnits),
        backendTitle: S.Label,
        modelId: S.ModelId,
        presetLabel: S.Label,
        createdAt: count,
      },
      { reasoningEffort: text(limits.effortUnits) },
    ),
  TurnStatus: () =>
    record(
      { turnId: S.Id, state: S.TurnState, round: count, at: count },
      { error: S.Reason, resolution: S.Reason },
    ),
  /** A turn in a history page: its records in order, text fields cut to previews. */
  TurnPreview: () =>
    record(
      {
        turn: M.remotable('Turn'),
        turnId: S.Id,
        state: S.TurnState,
        at: count,
        records: list(S.TurnRecord, limits.historyTurnRecords),
      },
      { cut: M.boolean() },
    ),
  /**
   * M2: `archived` when the turns before `next` are sealed (read them
   * through `History.page`); `archive` whenever the session has sealed
   * segments (m2-interfaces.md 4.9).
   */
  HistoryPage: () =>
    record(
      { turns: list(S.TurnPreview, limits.historyPageTurns) },
      { next: S.Cursor, archived: M.boolean(), archive: S.ArchiveState },
    ),
  CurrentTurn: () =>
    record({
      input: staged(S.SubmissionText),
      turn: M.remotable('Turn'),
      history: S.TurnPreview,
    }),
  WatchSnapshot: () =>
    record(
      {
        rev: count,
        info: S.SessionInfo,
        pending: S.PendingView,
        usage: S.UsageTotals,
      },
      { current: S.TurnStatus },
    ),
  // ---- live channel events ----

  /** Events a session vat publishes (architecture 4.2). */
  VatEvent: () =>
    M.or(
      record({
        type: 'turn-start',
        turnId: S.Id,
        input: staged(S.SubmissionText),
        at: count,
      }),
      record({ type: 'phase', turnId: S.Id, phase: S.Phase }),
      record({
        type: 'tool_call',
        turnId: S.Id,
        id: S.Id,
        name: S.ToolName,
        args: staged(S.Text),
      }),
      record({
        type: 'tool_result',
        turnId: S.Id,
        id: S.Id,
        name: S.ToolName,
        result: staged(text(limits.toolOutputUnits)),
        failed: M.boolean(),
      }),
      record({ type: 'final', turnId: S.Id, text: staged(S.Text) }),
      record({
        type: 'usage',
        turnId: S.Id,
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        cacheWriteInputTokens: count,
        reasoningOutputTokens: count,
        context: S.ContextReading,
        turns: count,
        incompleteTurns: count,
      }),
      record({ type: 'end', turnId: S.Id, status: S.SettledStatus }),
      record({ type: 'abort', turnId: S.Id, reason: S.Reason }),
      record({ type: 'pending', pending: S.PendingView }),
    ),
  /** `LivePublisher.publish` argument: one batch per crank. */
  PublishBatch: () =>
    record({
      rev: count,
      events: list(S.VatEvent, limits.publishBatchEvents),
    }),
  /** The adapter's text delta (published in-process, never through a vat). */
  DeltaEvent: () =>
    record({
      type: 'delta',
      turnId: S.Id,
      round: count,
      text: M.string({ stringLengthLimit: limits.scriptRepeat }),
    }),
  FoldedMessage: () =>
    record(
      { role: M.or('assistant', 'tool', 'thinking') },
      {
        text: M.string({ stringLengthLimit: limits.foldTextUnits }),
        id: S.Id,
        name: S.ToolName,
        args: S.Text,
        result: M.or(null, text(limits.toolOutputUnits)),
        failed: M.boolean(),
      },
    ),
  /** reply-fold's FoldableStatus. */
  FoldableStatus: () =>
    record({
      phase: text(limits.labelUnits),
      streamingText: M.string({ stringLengthLimit: limits.foldTextUnits }),
      messages: list(S.FoldedMessage, limits.foldMessages),
      error: M.or(null, S.Reason),
      usage: M.or(null, S.UsageTotals),
    }),
  /** First event of every subscription: the current (or last) turn's fold. */
  SnapshotEvent: () =>
    record(
      { type: 'snapshot' },
      {
        turn: record({
          turnId: S.Id,
          settled: M.boolean(),
          status: S.FoldableStatus,
        }),
      },
    ),
  /** What a subscriber receives: every event numbered by the channel. */
  Delivery: () =>
    record({
      seq: count,
      rev: count,
      event: M.or(S.SnapshotEvent, S.DeltaEvent, S.VatEvent),
    }),
  LiveBatch: () =>
    record(
      { deliveries: list(S.Delivery, limits.liveBatchDeliveries) },
      // `reason` (M1b, J-9172): why the channel closed this subscriber.
      { closed: M.boolean(), reason: B.CloseReason },
    ),
  RowPatch: () =>
    record(
      {},
      {
        title: text(limits.titleUnits),
        activity: S.Activity,
        messageCount: count,
        queuedCount: count,
        // M2 W2.7 (m2-interfaces.md 7.2): an imported session reports the
        // end of its import; the factory lists its row from then on.
        imported: true,
      },
    ),
  SessionRow: () =>
    record(
      {
        session: M.remotable('Session'),
        key: S.Id,
        title: text(limits.titleUnits),
        state: S.Lifecycle,
        activity: S.Activity,
        backendTitle: S.Label,
        modelId: S.ModelId,
        messageCount: count,
        queuedCount: count,
      },
      { effort: text(limits.effortUnits) },
    ),
  SessionPage: () =>
    record(
      { rows: list(S.SessionRow, limits.sessionPageRows), rev: count },
      { next: S.Id },
    ),
  CreateOptions: () =>
    record(
      {},
      {
        title: text(limits.titleUnits),
        preset: M.remotable('Preset'),
        backend: M.remotable('Backend'),
        modelId: S.ModelId,
        reasoningEffort: text(limits.effortUnits),
        systemPrompt: S.Text,
        networkPolicy: M.any(),
        userInitiated: M.boolean(),
        spoken: M.boolean(),
        // When the caller made the request (ms since the epoch): the caller
        // has the clock (as the Composer stamps enqueueOnce); the session's
        // createdAt. Absent: the factory's latest known time.
        at: count,
        // Admitted only so the factory can refuse it with the R4-6 text.
        model: M.any(),
      },
    ),
  SessionConfig: () =>
    record(
      {
        key: S.Id,
        title: text(limits.titleUnits),
        backendTitle: S.Label,
        modelId: S.ModelId,
        preset: S.PresetSnapshot,
        createdAt: count,
        userInitiated: M.boolean(),
      },
      {
        reasoningEffort: text(limits.effortUnits),
        // M2: the prompt composed at creation (R4-26..R4-28), staged when
        // over inlineBytes; the window of the resolved model (R4-33); the
        // turn deadline (0 or absent: off; m2-interfaces.md 10).
        systemPrompt: staged(S.Text),
        contextLength: count,
        maxOutputTokens: count,
        turnDeadlineMs: count,
      },
    ),
  SessionServices: () =>
    record(
      {
        backend: M.remotable('Backend'),
        host: M.remotable('SessionHostFacet'),
      },
      // M1b W1b.5: the session's exec vat lease (architecture 3.2).
      { execVat: M.remotable('ExecHandle') },
    ),
  MakeArgs: () =>
    record({
      config: S.SessionConfig,
      services: S.SessionServices,
      rowReporter: M.remotable('RowReporter'),
    }),
  MadeSession: () =>
    record({
      session: M.remotable('Session'),
      internal: M.remotable('SessionInternal'),
    }),
  ProgramPiece: () =>
    record({
      digest: text(64),
      index: count,
      count,
      text: text(limits.frameBytes),
    }),
  // `keys` (integration J-9381): the scripted provider builds the text in the
  // adapter, `{"<prefix><from>":<from>,...}` with `count` keys (`text` is
  // then ignored), so a flood of fresh keys need not cross the manager vat
  // inside the script (a script of 2 MB halted it, C-5).
  ScriptKeys: () =>
    record({ prefix: text(limits.callIdUnits), from: count, count }),
  ScriptChunk: () =>
    record(
      { text: S.Text },
      { repeat: count, delayMs: count, keys: S.ScriptKeys },
    ),
  ScriptToolCall: () =>
    record(
      { name: S.ToolName },
      {
        callId: text(limits.callIdUnits),
        args: S.Text,
        argsKeys: count,
        // Integration (J-9381): args = JSON.stringify({ text: keys }) built
        // in the adapter, as ScriptChunk's `keys`.
        argsFreshKeys: S.ScriptKeys,
        // M1b: args = JSON.stringify({ code: text repeated }) (exec probes).
        code: record({ text: S.Text }, { repeat: count }),
        // W1b.6: the call appears `times` times (too-big probe: 300 calls).
        times: count,
      },
    ),
  ScriptRound: () =>
    record(
      {},
      {
        chunks: list(S.ScriptChunk, limits.scriptChunks),
        chunkDelayMs: count,
        dispatchDelayMs: count,
        toolCalls: list(S.ScriptToolCall, limits.maxCallsPerMessage),
        usage: S.Usage,
        error: S.Reason,
        stall: 'untilCancel',
        // M1b: opaque native context for this round, staged as a Blob (R4-31).
        nativeContext: S.Text,
        // M2 W2.6: the round stands for this many rounds in a row (the
        // round-limit probe runs maxToolRounds rounds from one frame).
        times: M.and(count, M.lte(limits.maxToolRounds + 1)),
      },
    ),
  ScriptTurn: () =>
    record(
      { rounds: list(S.ScriptRound, limits.scriptRounds) },
      { input: S.SubmissionText },
    ),
  Script: () => record({ turns: list(S.ScriptTurn, limits.scriptRounds) }),
  /** M2: the backend kinds (R4-12, R4-13); `scripted` is the test double; M4 (H-1): the pool kinds. */
  BackendKind: () =>
    M.or('scripted', 'openrouter', 'anthropic', 'claude-pool', 'codex-pool'),
  /**
   * `AgentHostAdmin.makeBackend` argument. M2 adds the API kinds: the key is
   * a `ReadGrant` (D-6, R7-28), never a value; `modelId` is the slot's
   * configured model (R4-21, R4-88); `baseUrl` points a test at the fake
   * server (F.2 c); `timeoutMs` is the request timeout (R4-93).
   */
  BackendSpec: () =>
    M.or(
      record(
        { kind: 'scripted', label: S.Label, script: S.Script },
        { logPath: text(4096) },
      ),
      record(
        {
          kind: M.or('openrouter', 'anthropic'),
          label: S.Label,
          keyGrant: M.remotable('ReadGrant'),
        },
        {
          modelId: S.ModelId,
          baseUrl: text(limits.urlUnits),
          timeoutMs: M.and(count, M.gte(1000), M.lte(limits.maxTurnDeadlineMs)),
          maxOutputTokens: count,
          logPath: text(4096),
        },
      ),
    ),
  BackendInfo: () =>
    record(
      { kind: S.BackendKind, label: S.Label },
      // M2: the default model of an API backend (R4-21, R4-88).
      { modelId: S.ModelId },
    ),
};

export const echoArgumentNames = harden(['text', 'delayMs', 'bytes', 'data']);

/** echo as offered to the model (AH/tools/echo.js and the vat's tool table). */
export const echoDescription = harden({
  name: 'echo',
  description:
    'Test tool: returns `text` (repeated or cut to `bytes` characters when given) after `delayMs` milliseconds. `data` is accepted and ignored.',
  parameters: JSON.stringify({
    type: 'object',
    properties: {
      text: { type: 'string' },
      delayMs: { type: 'number', minimum: 0 },
      bytes: { type: 'number', minimum: 0 },
      data: {},
    },
    additionalProperties: false,
  }),
});

// ---------------------------------------------------------------- interfaces

/** @param {string} label */
const R = label => M.remotable(label);
const done = M.undefined();

/**
 * Return guards of `getHistoryPage` and `getCurrentTurn` (contract 3.1,
 * J-0243, J-9156). Their records were checked against their closed shape
 * when they were appended (records.js) and a preview only shortens strings
 * or drops intents, so the return guard checks the page's structure and
 * bounds (turn and record counts, ids, states) and each record only for
 * being a key (passable data: no promise, error or unknown object; pass
 * styles are memoized per hardened object): one `M.splitRecord` per turn
 * instead of an `M.or` of eight closed records per record. `M.record()`
 * would walk every entry of every record again (about 30 us per record in
 * Node against 3 us for `M.key()`, J-9156). Not in `shapes`: they do not
 * bound strings inside records (the strict `shapes.HistoryPage` and
 * `shapes.CurrentTurn` still describe the value).
 * @type {Map<string, any>}
 */
const views = new Map();
/** @param {string} name */
const view = name => {
  if (!views.has(name)) {
    const preview = record(
      {
        turn: R('Turn'),
        turnId: S.Id,
        state: S.TurnState,
        at: count,
        records: list(M.key(), limits.historyTurnRecords),
      },
      { cut: M.boolean() },
    );
    views.set(
      'HistoryPage',
      record(
        { turns: list(preview, limits.historyPageTurns) },
        { next: S.Cursor, archived: M.boolean(), archive: S.ArchiveState },
      ),
    );
    views.set(
      'CurrentTurn',
      record({
        input: staged(S.SubmissionText),
        turn: R('Turn'),
        history: preview,
      }),
    );
  }
  return views.get(name);
};

/**
 * Method guards of interfaces later milestones extend: the M1a methods, then
 * (in `foldedMethods` below) M1b's, then (in `m2InterfaceBuilders`) M2's,
 * always in that order.
 */
const methodsOf = harden({
  Turn: () => ({
    getStatus: M.call().returns(S.TurnStatus),
    cancel: M.call().returns(done),
    whenFinished: M.callWhen().returns(S.TurnStatus),
    resolve: M.call(S.Reason).returns(done),
  }),
  TurnSink: () => ({
    dispatching: M.call(count).returns(M.boolean()),
    roundFinal: M.call(S.RoundResult).returns(done),
    roundFailed: M.call(S.RoundFailure).returns(done),
    deadline: M.call(record({ opId: S.Id })).returns(done),
  }),
  Live: () => ({
    subscribe: M.callWhen(R('Session'))
      .optional(count)
      .returns(R('LiveSubscription')),
  }),
  AgentHostAdmin: () => ({
    makeBackend: M.callWhen(S.BackendSpec).returns(R('Backend')),
    forSession: M.call().returns(R('SessionHostFacet')),
    bindSession: M.call(R('SessionHostFacet'), R('Session')).returns(done),
    onStart: M.call(R('StartListener')).returns(R('Registration')),
    live: M.callWhen().returns(R('Live')),
    composer: M.callWhen().returns(R('Composer')),
  }),
  SessionFactory: () => ({
    createSession: M.callWhen(S.CreateOptions).returns(R('Session')),
    listSessions: M.call()
      .optional(record({}, { after: S.Id, limit: count }))
      .returns(S.SessionPage),
    findSession: M.call(S.Id).returns(R('Session')),
    listPresets: M.call().returns(list(R('Preset'), 64)),
  }),
  Session: () => ({
    getInfo: M.call().returns(S.SessionInfo),
    rename: M.call(text(limits.titleUnits)).returns(done),
    watch: M.call().returns(S.WatchSnapshot),
    enqueueOnce: M.call(
      S.Submission,
      text(limits.requestIdUnits),
      count,
    ).returns(S.Receipt),
    getSubmissionReceipt: M.call(text(limits.requestIdUnits)).returns(
      M.or(done, S.Receipt),
    ),
    listPending: M.call().returns(S.PendingView),
    startTurn: M.call(S.Submission).optional(count).returns(R('Turn')),
    getCurrentTurn: M.call().returns(M.or(done, view('CurrentTurn'))),
    getHistoryPage: M.call().optional(S.Cursor).returns(view('HistoryPage')),
    getUsage: M.call().returns(S.UsageTotals),
  }),
  SessionInternal: () => ({
    rowSnapshot: M.call().returns(S.RowPatch),
  }),
  QueueEntry: () => ({
    describe: M.call().returns(S.EntryInfo),
    cancel: M.call().returns(M.boolean()),
  }),
  Backend: () => ({
    describe: M.call().returns(S.BackendInfo),
    open: M.callWhen(R('SessionHostFacet')).returns(S.TurnPorts),
  }),
  Composer: () => ({
    submit: M.callWhen(
      R('Session'),
      M.string({ stringLengthLimit: limits.messageUnits }),
      text(limits.requestIdUnits),
    ).returns(S.Receipt),
  }),
  Operator: () => ({
    getFactory: M.call().returns(R('SessionFactory')),
  }),
});

/**
 * M1a's interface guards (W1a.0). `interfaces` below holds them with M1b's
 * (whose versions replace the M1a ones they extend) and M2's new ones.
 */
const m1aInterfaceBuilders = {
  // ---- session vat (W1a.4, W1a.5) ----

  /** The session's public facet (architecture 3.2; A.4 session facet). */
  Session: () => M.interface('Session', methodsOf.Session()),

  /** Held only by the factory (architecture 3.2). */
  SessionInternal: () =>
    M.interface('SessionInternal', methodsOf.SessionInternal()),

  /** One turn (A.4 turn handle, object style). */
  Turn: () => M.interface('Turn', methodsOf.Turn()),

  /** One waiting queue entry (A.4 queue; edit and sendNow arrive in M2). */
  QueueEntry: () => M.interface('QueueEntry', methodsOf.QueueEntry()),

  /** Passed in every startRound; the adapter reports the round through it. */
  TurnSink: () => M.interface('TurnSink', methodsOf.TurnSink()),

  /** Shape only in M1a; built in M1b (architecture 4.5, D-9). */
  ContextSource: () =>
    M.interface('ContextSource', {
      page: M.call()
        .optional(S.Cursor)
        .returns(
          record(
            { records: list(S.TurnRecord, limits.maxAppendRecords) },
            { next: S.Cursor },
          ),
        ),
    }),

  /** What the evaluating crank of the session program returns (M1a cold create; M1b pool). */
  SpareMaker: () =>
    M.interface('SpareMaker', {
      make: M.call(S.MakeArgs).returns(S.MadeSession),
    }),

  // ---- agent-host adapter objects (W1a.2, W1a.3); transient ----

  /** One turn's connection to the backend (architecture 3.3, D-5). */
  Endpoint: () =>
    M.interface('Endpoint', {
      holdTurn: M.callWhen(R('Turn')).returns(done),
      releaseTurn: M.call(R('Turn')).returns(done),
      startRound: M.call(S.RoundRequest).returns(done),
      cancelRound: M.call(R('Turn')).returns(done),
      armDeadline: M.call(
        record({ turn: R('Turn'), opId: S.Id, ms: count }),
      ).returns(done),
      disarm: M.call(record({ turn: R('Turn'), opId: S.Id })).returns(done),
    }),

  /** A session channel's publisher facet (D-8). */
  LivePublisher: () =>
    M.interface('LivePublisher', {
      publish: M.call(S.PublishBatch).returns(done),
    }),

  /** A tool that runs in the agent-host adapter (M1a: echo). */
  AdapterTool: () =>
    M.interface('AdapterTool', {
      execute: M.callWhen(S.ToolRequest).returns(S.ToolOutcome),
    }),

  /** Gateway-local subscription service (D-8); tests reach it through AgentHostAdmin.live(). */
  Live: () => M.interface('Live', methodsOf.Live()),

  /** A channel's subscriber facet, one per subscriber. */
  LiveSubscription: () =>
    M.interface('LiveSubscription', {
      next: M.callWhen().returns(S.LiveBatch),
      close: M.call().returns(done),
    }),

  /** Gateway-local submissions (D-12); stamps `at`. */
  Composer: () => M.interface('Composer', methodsOf.Composer()),

  // ---- agent-host manager vat objects (W1a.2); durable ----

  /** A configured backend (architecture 3.3); held by the factory and sessions. */
  Backend: () => M.interface('Backend', methodsOf.Backend()),

  /** Minted per session by forSession(); given only to that session's vat. */
  SessionHostFacet: () =>
    M.interface('SessionHostFacet', {
      liveChannel: M.callWhen().returns(R('LivePublisher')),
    }),

  /** A start-notice registration. */
  Registration: () =>
    M.interface('Registration', {
      cancel: M.call().returns(done),
    }),

  /** The manager's admin facet, installed as `agentHostAdmin`; held by the factory and the operator. */
  AgentHostAdmin: () =>
    M.interface('AgentHostAdmin', methodsOf.AgentHostAdmin()),

  // ---- factory vat (W1a.6) ----

  /** Per-session row reporter, held by that session only (architecture 3.1). */
  RowReporter: () =>
    M.interface('RowReporter', {
      changed: M.call(S.RowPatch).returns(done),
    }),

  /** The factory's start listener, registered with AgentHostAdmin.onStart. */
  StartListener: () =>
    M.interface('StartListener', {
      started: M.call().returns(done),
    }),

  /** A preset (M1a: the built-in `chat-only`). */
  Preset: () =>
    M.interface('Preset', {
      describe: M.call().returns(
        record({ label: S.Label, builtIn: M.boolean() }),
      ),
      snapshot: M.call().returns(S.PresetSnapshot),
    }),

  /** The session factory (architecture 3.1; A.4 factory, object style). */
  SessionFactory: () =>
    M.interface('SessionFactory', methodsOf.SessionFactory()),

  /** The one object the gateway publishes (F.1 #10). */
  Operator: () => M.interface('Operator', methodsOf.Operator()),

  /** Inventory label `harness`; operator-only through the control socket. */
  HarnessRoot: () =>
    M.interface('HarnessRoot', {
      getOperator: M.call().returns(R('Operator')),
      status: M.call().returns(
        record({
          sessions: count,
          program: record({ digest: text(64), bytes: count }),
        }),
      ),
      loadSessionProgram: M.call(S.ProgramPiece).returns(
        record({ complete: M.boolean(), bytes: count }),
      ),
    }),
};

/** M1a's method names per interface, in declaration order. */
const m1aMethodNames = harden({
  Session: [
    'getInfo',
    'rename',
    'watch',
    'enqueueOnce',
    'getSubmissionReceipt',
    'listPending',
    'startTurn',
    'getCurrentTurn',
    'getHistoryPage',
    'getUsage',
  ],
  SessionInternal: ['rowSnapshot'],
  Turn: ['getStatus', 'cancel', 'whenFinished', 'resolve'],
  QueueEntry: ['describe', 'cancel'],
  TurnSink: ['dispatching', 'roundFinal', 'roundFailed', 'deadline'],
  ContextSource: ['page'],
  SpareMaker: ['make'],
  Endpoint: [
    'holdTurn',
    'releaseTurn',
    'startRound',
    'cancelRound',
    'armDeadline',
    'disarm',
  ],
  LivePublisher: ['publish'],
  AdapterTool: ['execute'],
  Live: ['subscribe'],
  LiveSubscription: ['next', 'close'],
  Composer: ['submit'],
  Backend: ['describe', 'open'],
  SessionHostFacet: ['liveChannel'],
  Registration: ['cancel'],
  AgentHostAdmin: [
    'makeBackend',
    'forSession',
    'bindSession',
    'onStart',
    'live',
    'composer',
  ],
  RowReporter: ['changed'],
  StartListener: ['started'],
  Preset: ['describe', 'snapshot'],
  SessionFactory: [
    'createSession',
    'listSessions',
    'findSession',
    'listPresets',
  ],
  Operator: ['getFactory'],
  HarnessRoot: ['getOperator', 'status', 'loadSessionProgram'],
});

// ================================================================ M1b
//
// The M1b contract (W1b.0): m1b-interfaces.md section 1.3 says how these
// tables relate to the M1a ones and when an implementer switches.

/** `exec` as offered to the model (W1b.4); its argument names (R3-41, R4-43). */
export const execArgumentNames = harden(['code']);
export const execDescription = harden({
  name: 'exec',
  description:
    'Run JavaScript in your persistent scope. The code is the body of an async function: top-level await works, and a top-level return gives the result (JSON-rendered). In scope: powers, E (eventual send: E(ref).method()), harden, console (output is discarded), sleep(ms). Top-level const and let are per call; globalThis.name = value persists across calls, turns and restarts, until the scope is reset (a reset is always stated in the result). No Date, Math.random, timers, import or require. A call that runs longer than the exec deadline is stopped and resets the scope.',
  parameters: JSON.stringify({
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'JavaScript; runs as an async function body. Return a result.',
      },
    },
    required: ['code'],
    additionalProperties: false,
  }),
});

/** M1b's shapes (W1b.0); in `shapes` since M2 W2.0. */
const m1bShapeBuilders = {
  /**
   * Text over inlineBytes (D-15; m1b-interfaces.md 4). `digest` (M1b
   * follow-ups, J-9360): the SHA-256 of the text's UTF-8 bytes, 64 lowercase
   * hex digits, computed by the adapter that wrote the file; every staging
   * from then on carries it. Optional only so records staged before it stay
   * valid. Duplicates compare by it (3.3).
   */
  StagedText: () =>
    record(
      {
        blob: M.remotable('Blob'),
        preview: text(limits.messagePreviewUnits),
        bytes: count,
      },
      { digest: text(64) },
    ),
  /** `TurnSink.progress`: the round's whole text so far, staged; `tail` its last units. */
  Progress: () =>
    record({
      round: count,
      partial: B.StagedText,
      tail: text(limits.messagePreviewUnits),
      at: count,
    }),
  /** `Content.read` range: UTF-8 byte offset and the page budget. */
  ContentRange: () =>
    record({
      offset: count,
      maxBytes: M.and(count, M.lte(limits.blobPageBytes)),
    }),
  /** One page of a blob: whole code points; `next` is the byte offset after it. */
  ContentPage: () =>
    record({
      text: text(limits.blobPageBytes),
      next: count,
      done: M.boolean(),
    }),
  /** `Timer.sleep` argument (exec `sleep(ms)`, clamped by the exec vat). */
  SleepMs: () => M.and(count, M.lte(limits.maxDelayMs)),
  /** `ExecHandle.scope()`: the session's current exec scope and its deadline. */
  ExecLease: () =>
    record({ scope: M.remotable('ExecScope'), deadlineMs: count }),
  /** `ExecScope.run` argument (m1b-interfaces.md 3.4). */
  ExecRequest: () =>
    record(
      {
        args: staged(text(limits.inlineBytes)),
        writers: M.remotable('BlobWriters'),
        timer: M.remotable('Timer'),
      },
      { content: M.remotable('Content'), notice: S.Reason },
    ),
  /**
   * `ExecScope.run` answer: a ToolOutcome; `busy` at once while a call runs;
   * `exhausted` when the vat's name table ran out (M1b QC: retire it).
   */
  ExecOutcome: () =>
    M.or(
      S.ToolOutcome,
      record({ status: 'busy' }),
      record({ status: 'exhausted' }),
    ),
  /** `ContextSource.page` answer: records from absolute index `from`. */
  ContextPage: () =>
    record(
      { from: count, records: list(S.TurnRecord, limits.pageRecords) },
      { next: S.Cursor },
    ),
  /** `Turn.getContent` answer: the turn's records in full, in log order. */
  TurnContentPage: () =>
    record(
      { records: list(S.TurnRecord, limits.pageRecords) },
      { next: S.Cursor },
    ),
  /** Manager sink (W1b.1 internal): a minted handle and its file key. */
  BlobStockEntry: () => record({ blob: M.remotable('Blob'), key: S.Id }),
  BlobStock: () => list(B.BlobStockEntry, limits.blobStockBatch),
  /** Manager sink `resolveBlobs` answer: a key per handle, null if unknown. */
  BlobKeys: () => list(M.or(null, S.Id), limits.blobResolveBatch),
  /** M2 delete hook (shape only in M1b): one page of a session's blobs. */
  BlobPage: () =>
    record(
      { blobs: list(M.remotable('Blob'), limits.blobResolveBatch) },
      { next: S.Cursor },
    ),
  /** Why a channel closed a subscriber (`AH/channels.js` closeReasons keys). */
  CloseReason: () =>
    M.or('client', 'queueDeliveries', 'queueBytes', 'subscriberLimit'),
  /** A session-list change (D-8; architecture 3.1). */
  ListEvent: () =>
    M.or(
      record({ type: 'row', row: S.SessionRow }),
      record({
        type: 'row-removed',
        session: M.remotable('Session'),
        key: S.Id,
      }),
    ),
  /** `ListPublisher.publish` argument: one batch per factory crank. */
  ListPublishBatch: () =>
    record({
      rev: count,
      events: list(B.ListEvent, limits.publishBatchEvents),
    }),
  ListSnapshotEvent: () => record({ type: 'list-snapshot' }),
  ListDelivery: () =>
    record({
      seq: count,
      rev: count,
      event: M.or(B.ListSnapshotEvent, B.ListEvent),
    }),
  ListBatch: () =>
    record(
      { deliveries: list(B.ListDelivery, limits.liveBatchDeliveries) },
      { closed: M.boolean(), reason: B.CloseReason },
    ),
  ListFeedInfo: () => record({ rev: count }),
  PoolCounts: () =>
    record({
      spareSessions: M.and(count, M.lte(limits.maxSpares)),
      spareExec: M.and(count, M.lte(limits.maxSpares)),
    }),
  /** `HarnessRoot.whenSettled()` / `status().pool`. */
  PoolStatus: () =>
    record({
      spareSessions: count,
      spareExec: count,
      refilling: count,
      target: B.PoolCounts,
    }),
  /**
   * `HarnessRoot.configure` argument (operator settings, architecture 9).
   * M2 (m2-interfaces.md 8.5, 10): the backends `listBackends` offers, the
   * default backend and model of a creation that names none (R4-21, R4-88),
   * and the turn deadline (0: off).
   */
  HarnessSettings: () =>
    record(
      {},
      {
        spareSessions: M.and(count, M.lte(limits.maxSpares)),
        spareExec: M.and(count, M.lte(limits.maxSpares)),
        execDeadlineMs: M.and(count, M.gte(1000), M.lte(limits.maxDelayMs)),
        backends: list(M.remotable('Backend'), limits.maxBackends),
        defaultBackend: M.remotable('Backend'),
        defaultModelId: S.ModelId,
        turnDeadlineMs: M.and(count, M.lte(limits.maxTurnDeadlineMs)),
      },
    ),
  ProgramInfo: () => record({ digest: text(64), bytes: count }),
  HarnessStatus: () =>
    record(
      { sessions: count, program: B.ProgramInfo },
      { execProgram: B.ProgramInfo, pool: B.PoolStatus },
    ),
};

/**
 * Structural return guards of record pages (records as keys, J-9156).
 * @type {Map<string, any>}
 */
const pageViews = new Map();
/** @param {'ContextPage' | 'TurnContentPage'} name */
const pageView = name => {
  if (!pageViews.has(name)) {
    const records = list(M.key(), limits.pageRecords);
    pageViews.set(
      'ContextPage',
      record({ from: count, records }, { next: S.Cursor }),
    );
    pageViews.set('TurnContentPage', record({ records }, { next: S.Cursor }));
  }
  return pageViews.get(name);
};

/**
 * Method guards of the M1b versions that M2 extends again (M1a's methods
 * first, then M1b's).
 */
const foldedMethodsOf = harden({
  ContextSource: () => ({
    page: M.call().optional(S.Cursor).returns(pageView('ContextPage')),
  }),
  AgentHostAdmin: () => ({
    ...methodsOf.AgentHostAdmin(),
    content: M.callWhen().returns(R('Content')),
    listPublisher: M.callWhen().returns(R('ListPublisher')),
  }),
  SessionFactory: () => ({
    ...methodsOf.SessionFactory(),
    sessionListFeed: M.call().returns(B.ListFeedInfo),
  }),
  HarnessRoot: () => ({
    getOperator: M.call().returns(R('Operator')),
    status: M.call().returns(B.HarnessStatus),
    loadSessionProgram: M.call(S.ProgramPiece).returns(
      record({ complete: M.boolean(), bytes: count }),
    ),
    loadExecProgram: M.call(S.ProgramPiece).returns(
      record({ complete: M.boolean(), bytes: count }),
    ),
    configure: M.call(B.HarnessSettings).returns(B.PoolStatus),
    whenSettled: M.callWhen().returns(B.PoolStatus),
  }),
});

/** M1b's interface guards (W1b.0); in `interfaces` since M2 W2.0. */
const m1bInterfaceBuilders = {
  // ---- blobs and content (W1b.1) ----

  /** Manager-minted handle (D-15); no methods: read it through Content. */
  Blob: () => M.interface('Blob', {}),
  /** Adapter: opens a writer for one blob (TurnPorts.writers; the exec vat). */
  BlobWriters: () =>
    M.interface('BlobWriters', {
      open: M.callWhen().returns(R('BlobWriter')),
    }),
  /** Adapter: one blob being written; `close` fsyncs and answers its StagedText. */
  BlobWriter: () =>
    M.interface('BlobWriter', {
      append: M.callWhen(text(limits.blobPieceBytes)).returns(done),
      close: M.callWhen().returns(B.StagedText),
      abort: M.call().returns(done),
    }),
  /** Adapter: reads any blob whose handle the caller holds. */
  Content: () =>
    M.interface('Content', {
      read: M.callWhen(R('Blob'), B.ContentRange).returns(B.ContentPage),
    }),
  /** Adapter timer (exec `sleep`). */
  Timer: () =>
    M.interface('Timer', {
      sleep: M.callWhen(B.SleepMs).returns(done),
    }),

  // ---- session vat (W1b.1, W1b.2) ----

  /** M1a TurnSink + `progress` (W1b.1). */
  TurnSink: () =>
    M.interface('TurnSink', {
      ...methodsOf.TurnSink(),
      // Answered from M1b QC (J-0393): true when the session kept this
      // checkpoint in place of the previous one, so the adapter may delete
      // the previous one's file.
      progress: M.call(B.Progress).returns(M.boolean()),
    }),
  /** M1a Turn + `getContent` (W1b.1). */
  Turn: () =>
    M.interface('Turn', {
      ...methodsOf.Turn(),
      getContent: M.call()
        .optional(S.Cursor)
        .returns(pageView('TurnContentPage')),
    }),
  /** The session's records for the adapter's context cache (W1b.2; D-9). */
  ContextSource: () =>
    M.interface('ContextSource', foldedMethodsOf.ContextSource()),

  // ---- exec (W1b.3 vat, W1b.5 handle) ----

  /** The exec vat's one persistent scope (architecture 6, D-11). */
  ExecScope: () =>
    M.interface('ExecScope', {
      run: M.callWhen(B.ExecRequest).returns(B.ExecOutcome),
      // M1b QC (J-0391): the session gave the running call up (cancel or
      // recovery); sendOnly. The call ends now: its run answers
      // `execAbandoned`, its `sleep` never settles again, the scope is kept.
      abandon: M.call().returns(done),
    }),
  /** Factory: the session's exec vat lease (architecture 3.2). */
  ExecHandle: () =>
    M.interface('ExecHandle', {
      scope: M.callWhen().returns(B.ExecLease),
      retire: M.call(R('ExecScope')).returns(done),
    }),

  // ---- session list feed (W1b.5) ----

  /** Adapter: the session list channel's publisher (held by the factory). */
  ListPublisher: () =>
    M.interface('ListPublisher', {
      publish: M.call(B.ListPublishBatch).returns(done),
    }),
  /** Adapter: one list subscriber. */
  ListSubscription: () =>
    M.interface('ListSubscription', {
      next: M.callWhen().returns(B.ListBatch),
      close: M.call().returns(done),
    }),
  /** M1a Live + `subscribeList`. */
  Live: () =>
    M.interface('Live', {
      ...methodsOf.Live(),
      subscribeList: M.callWhen()
        .optional(count)
        .returns(R('ListSubscription')),
    }),

  // ---- manager and factory (W1b.1, W1b.2, W1b.5) ----

  /** M1a AgentHostAdmin + `content`, `listPublisher`. */
  AgentHostAdmin: () =>
    M.interface('AgentHostAdmin', foldedMethodsOf.AgentHostAdmin()),
  /**
   * M1a StartListener + `attached` (M1b follow-ups, J-9362): the manager
   * tells its start listeners, sendOnly, each time a new adapter incarnation
   * attaches outside a daemon start (an adapter-only restart), so objects
   * they fetched from the previous incarnation (the list publisher) are
   * fetched again.
   */
  StartListener: () =>
    M.interface('StartListener', {
      started: M.call().returns(done),
      attached: M.call().returns(done),
    }),
  /** M1a SessionFactory + `sessionListFeed`. */
  SessionFactory: () =>
    M.interface('SessionFactory', foldedMethodsOf.SessionFactory()),
  /** M1a HarnessRoot + exec program, pool settings and settling. */
  HarnessRoot: () => M.interface('HarnessRoot', foldedMethodsOf.HarnessRoot()),
};

/** M1b's method names per interface (M1a's first where M1b extends one). */
const m1bMethodLists = harden({
  Blob: [],
  BlobWriters: ['open'],
  BlobWriter: ['append', 'close', 'abort'],
  Content: ['read'],
  Timer: ['sleep'],
  TurnSink: [...m1aMethodNames.TurnSink, 'progress'],
  Turn: [...m1aMethodNames.Turn, 'getContent'],
  ContextSource: ['page'],
  ExecScope: ['run', 'abandon'],
  ExecHandle: ['scope', 'retire'],
  ListPublisher: ['publish'],
  ListSubscription: ['next', 'close'],
  Live: [...m1aMethodNames.Live, 'subscribeList'],
  AgentHostAdmin: [
    ...m1aMethodNames.AgentHostAdmin,
    'content',
    'listPublisher',
  ],
  StartListener: [...m1aMethodNames.StartListener, 'attached'],
  SessionFactory: [...m1aMethodNames.SessionFactory, 'sessionListFeed'],
  HarnessRoot: [
    ...m1aMethodNames.HarnessRoot,
    'loadExecProgram',
    'configure',
    'whenSettled',
  ],
});

// ================================================================ M2
//
// The M2 contract (W2.0; designs/m2-interfaces.md). New shapes and new
// interfaces go into the folded tables; `m2Interfaces` holds the M2 versions
// of interfaces M2 extends (m2-interfaces.md 1.3).

/** M2's shapes (W2.0). */
const m2ShapeBuilders = {
  // ---- the record archive (D-M2-1; m2-interfaces.md 4) ----

  /**
   * Where a session's live records start: records before `sealedTo` are in
   * `segments` sealed segments, turns before `sealedTurns + 1` (by ordinal)
   * are archived, and `digest` is the last segment's chained digest ('' for
   * none).
   */
  ArchiveState: () =>
    record({
      sealedTo: count,
      sealedTurns: count,
      segments: count,
      digest: text(64),
    }),
  /**
   * One sealed segment as the vat indexes it: records [from, to), turns
   * firstTurn .. firstTurn + turns - 1 (ordinals), its record bytes, and its
   * chained digest (m2-interfaces.md 4.2).
   */
  SegmentEntry: () =>
    record({
      from: count,
      to: count,
      firstTurn: count,
      turns: count,
      records: count,
      bytes: count,
      digest: text(64),
    }),
  /** `ContextSource.segments` answer, oldest first. */
  SegmentPage: () =>
    record(
      { segments: list(S.SegmentEntry, limits.segmentPageEntries) },
      { next: S.Cursor },
    ),
  /**
   * `ArchivePort.seal` argument (crank S, m2-interfaces.md 4.4): the vat's
   * range and its fingerprint (`kinds`: one letter per record of the range,
   * in log order, `archiveKindLetters`; only the first
   * `archiveSegmentRecords` when one turn is larger); `previous` is the digest the new
   * segment chains to ('' for the first); `context` serves records the
   * adapter lacks (never below `from`).
   */
  SealRequest: () =>
    record({
      from: count,
      to: count,
      firstTurn: count,
      turns: count,
      records: count,
      bytes: count,
      firstTurnId: S.Id,
      lastTurnId: S.Id,
      kinds: text(limits.archiveSegmentRecords),
      epoch: count,
      previous: text(64),
      context: M.remotable('ContextSource'),
    }),
  /** `ArchivePort.seal` answer: the segment is durable (fsynced, renamed). */
  SealAnswer: () => S.SegmentEntry,
  /**
   * A staged field of an archived record as `History` shows it: no Blob
   * handle (the vat dropped it), a `SealedText` to read the text.
   */
  SealedField: () =>
    record(
      {
        sealed: M.remotable('SealedText'),
        preview: text(limits.messagePreviewUnits),
        bytes: count,
      },
      { digest: text(64) },
    ),
  /** `SealedText.describe()`. */
  SealedTextInfo: () =>
    record(
      { bytes: count, preview: text(limits.messagePreviewUnits) },
      { digest: text(64) },
    ),
  // ---- providers and the model catalogue (m2-interfaces.md 8) ----

  /** `Backend.listModels` / `SessionFactory.listModels` argument. */
  ModelRequest: () =>
    record(
      {},
      {
        backend: M.remotable('Backend'),
        after: text(limits.modelCursorUnits),
        limit: M.and(count, M.lte(limits.modelPageRows)),
        // W2.2 (R4-20): the factory's default backend and configured model,
        // added by the factory when it forwards to `Backend.listModels`, so
        // the catalogue can mark the default row and choose bare selection
        // ids on the default backend. Absent: no row is default and every
        // selection id is `<label>:<model>`.
        defaultBackend: M.remotable('Backend'),
        defaultModelId: S.ModelId,
      },
    ),
  /** A.4 model row, object style (R4-20): `backend` replaces the backend id. */
  ModelRow: () =>
    record(
      {
        backend: M.remotable('Backend'),
        modelId: S.ModelId,
        selectionId: text(limits.modelCursorUnits),
        title: S.Label,
        default: M.boolean(),
        reasoningEfforts: list(text(limits.effortUnits), limits.maxEfforts),
      },
      {
        description: text(limits.modelDescriptionUnits),
        defaultReasoningEffort: text(limits.effortUnits),
        contextLength: count,
        maxOutputTokens: count,
      },
    ),
  /**
   * One page of a catalogue (R4-17: `unavailable` with no rows on a failed
   * read; `error` is a fixed text, never a provider body).
   */
  ModelPage: () =>
    record(
      {
        rows: list(S.ModelRow, limits.modelPageRows),
        state: M.or('ok', 'unavailable'),
      },
      { next: text(limits.modelCursorUnits), error: S.Reason },
    ),
  /** `Backend.resolveModel` answer: what a creation stores (R4-21, R4-22). */
  ResolvedModel: () =>
    record(
      { modelId: S.ModelId },
      { contextLength: count, maxOutputTokens: count },
    ),
  // ---- secrets (m2-interfaces.md 9) ----

  /** `SecretsAdmin.create` argument (R7-25: description 1-200, no newline). */
  NewSecret: () =>
    record({
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
    }),
  /** `Secret.describe()`: never the value (R7-22, R7-26). */
  SecretInfo: () =>
    record({
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
      generation: count,
      state: M.or('active', 'revoked'),
      bytes: count,
    }),
  SecretPage: () =>
    record(
      { secrets: list(M.remotable('Secret'), limits.secretPageEntries) },
      { next: S.Cursor },
    ),
  /** One audit event (R7-24): fixed outcome and code, no bytes. */
  AuditEvent: () =>
    record(
      {
        at: count,
        label: S.Label,
        op: M.or('create', 'read', 'replace', 'revoke', 'delete'),
        outcome: M.or('attempted', 'succeeded', 'failed'),
      },
      { code: text(limits.secretCodeUnits), generation: count },
    ),
  AuditPage: () => list(S.AuditEvent, limits.auditPageEvents),
  /**
   * A value sealed to the adapter's X25519 key (D-6: the CLI path; the hub
   * carries only ciphertext). `publicKey` is the sender's ephemeral key.
   */
  SealedBox: () =>
    record({
      format: 'x25519-aes-256-gcm-1',
      publicKey: text(64),
      box: text(limits.sealedBoxUnits),
    }),
  /** A plain secret value (adapter-local writer only; never into a vat). */
  SecretValue: () => text(limits.secretValueBytes),
  ReadGrantInfo: () =>
    record({
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
    }),
  // ---- delete, export and importing (m2-interfaces.md 7) ----

  /** One waiting entry as exported. */
  ExportEntry: () =>
    record({
      submission: S.Submission,
      requestId: text(limits.requestIdUnits),
      at: count,
    }),
  /**
   * `SessionInternal.exportState` page and `importState` chunk: one `part`
   * each, in the order head, archive, records, queue, end.
   */
  SessionExportPage: () =>
    record(
      { part: M.or('head', 'archive', 'records', 'queue', 'end') },
      {
        info: S.SessionInfo,
        config: S.SessionConfig,
        usage: S.UsageTotals,
        archive: S.ArchiveState,
        segments: list(S.SegmentEntry, limits.segmentPageEntries),
        from: count,
        records: list(S.TurnRecord, limits.pageRecords),
        entries: list(S.ExportEntry, limits.maxWaiting),
        hold: S.Hold,
        next: S.Cursor,
      },
    ),
  /** `SessionInternal.importState` answer. */
  ImportProgress: () => record({ records: count, complete: M.boolean() }),
  /** One session of `HarnessRoot.exportState`. */
  ExportSession: () =>
    record({
      session: M.remotable('Session'),
      internal: M.remotable('SessionInternal'),
      key: S.Id,
      title: text(limits.titleUnits),
      state: S.Lifecycle,
      userInitiated: M.boolean(),
    }),
  /** `HarnessRoot.exportState` page: settings first, then sessions. */
  FactoryExportPage: () =>
    record(
      { sessions: list(S.ExportSession, limits.sessionPageRows) },
      { settings: B.HarnessSettings, next: S.Id },
    ),
};

/**
 * Structural return guards of the archive's pages (records as keys, as
 * M1a's history views, J-9156): `History` builds them from segment files.
 * @type {Map<string, any>}
 */
const archiveViews = new Map();
/** @param {'SealedTurnPreview' | 'ArchiveHistoryPage' | 'SealedContentPage'} name */
const archiveView = name => {
  if (!archiveViews.has(name)) {
    const preview = record(
      {
        turnId: S.Id,
        state: S.TurnState,
        at: count,
        sealed: true,
        records: list(M.key(), limits.historyTurnRecords),
      },
      { cut: M.boolean(), resolution: S.Reason },
    );
    archiveViews.set('SealedTurnPreview', preview);
    archiveViews.set(
      'ArchiveHistoryPage',
      record(
        { turns: list(preview, limits.historyPageTurns) },
        { next: S.Cursor },
      ),
    );
    archiveViews.set(
      'SealedContentPage',
      record(
        { records: list(M.key(), limits.pageRecords) },
        { next: S.Cursor },
      ),
    );
  }
  return archiveViews.get(name);
};

/** M2's new interface guards (W2.0). */
const m2InterfaceBuilders = {
  // ---- archive (W2.8 adapter, W2.5 vat) ----

  /** Adapter: one session's archive in one incarnation (TurnPorts.archive). */
  ArchivePort: () =>
    M.interface('ArchivePort', {
      seal: M.callWhen(S.SealRequest).returns(S.SealAnswer),
    }),
  /**
   * Adapter-local (gateway, tests through `AgentHostAdmin.history()`):
   * history pages of any session, archived turns from segment files.
   */
  History: () =>
    M.interface('History', {
      page: M.callWhen(R('Session'))
        .optional(S.Cursor)
        .returns(M.or(view('HistoryPage'), archiveView('ArchiveHistoryPage'))),
      turnContent: M.callWhen(R('Session'), S.Id)
        .optional(S.Cursor)
        .returns(archiveView('SealedContentPage')),
    }),
  /** Adapter-local: the text of one archived staged field. */
  SealedText: () =>
    M.interface('SealedText', {
      read: M.callWhen(B.ContentRange).returns(B.ContentPage),
      describe: M.call().returns(S.SealedTextInfo),
    }),

  // ---- secrets (W2.3; D-6) ----

  /** Manager: the Secrets manager (R3-231, R7-22); held by the operator. */
  SecretsAdmin: () =>
    M.interface('SecretsAdmin', {
      list: M.call().optional(S.Cursor).returns(S.SecretPage),
      create: M.callWhen(S.NewSecret).returns(R('Secret')),
      openWriter: M.callWhen().returns(R('SecretWriter')),
      audit: M.callWhen()
        .optional(M.and(count, M.lte(limits.auditPageEvents)))
        .returns(S.AuditPage),
    }),
  /** Manager: one secret's admin facet (R7-23), reached from the catalogue. */
  Secret: () =>
    M.interface('Secret', {
      describe: M.callWhen().returns(S.SecretInfo),
      makeReadGrant: M.call().returns(R('ReadGrant')),
      revoke: M.callWhen().returns(done),
      delete: M.callWhen().returns(done),
      audit: M.callWhen()
        .optional(M.and(count, M.lte(limits.auditPageEvents)))
        .returns(S.AuditPage),
    }),
  /**
   * Manager: a read grant (R7-23). It has no read method: a value is read
   * only in the agent-host adapter, by the backend that holds the grant.
   */
  ReadGrant: () =>
    M.interface('ReadGrant', {
      describe: M.call().returns(S.ReadGrantInfo),
    }),
  /** Adapter-local: writes values (D-6); never in a vat. */
  SecretWriter: () =>
    M.interface('SecretWriter', {
      replace: M.callWhen(R('Secret'), M.or(S.SecretValue, S.SealedBox))
        .optional(count)
        .returns(record({ generation: count })),
      publicKey: M.call().returns(text(64)),
    }),
};

/**
 * `SessionInternal.importState` argument (W2.7, J-0481): a
 * `SessionExportPage` whose `records` are checked structurally (keys, as
 * the structural page views, J-9156). The session checks each record by
 * its kind as it appends it (`RecordLog.append`), so the guard does not
 * try the eight `TurnRecord` alternatives on every imported record first
 * (about 9 ms a record in a vat).
 * @type {any}
 */
let importChunk;
const importChunkView = () => {
  importChunk ??= record(
    { part: M.or('head', 'archive', 'records', 'queue', 'end') },
    {
      info: S.SessionInfo,
      config: S.SessionConfig,
      usage: S.UsageTotals,
      archive: S.ArchiveState,
      segments: list(S.SegmentEntry, limits.segmentPageEntries),
      from: count,
      records: list(M.key(), limits.pageRecords),
      entries: list(S.ExportEntry, limits.maxWaiting),
      hold: S.Hold,
      next: S.Cursor,
    },
  );
  return importChunk;
};

/** M2 versions of the interfaces M2 extends (folded methods first). */
const m2InterfaceBuilders2 = {
  /** + `findTurn` (W2.5; m2-interfaces.md 4.9). */
  Session: () =>
    M.interface('Session', {
      ...methodsOf.Session(),
      findTurn: M.call(S.Id).returns(R('Turn')),
    }),
  /** + delete, blob paging, data-only export and importing (W2.7). */
  SessionInternal: () =>
    M.interface('SessionInternal', {
      ...methodsOf.SessionInternal(),
      blobPage: M.call().optional(S.Cursor).returns(B.BlobPage),
      deleteSelf: M.call().returns(done),
      exportState: M.call().optional(S.Cursor).returns(S.SessionExportPage),
      importState: M.call(importChunkView()).returns(S.ImportProgress),
    }),
  /** + `edit`, `sendNow` (W2.4; A.4 editPending, sendPending). */
  QueueEntry: () =>
    M.interface('QueueEntry', {
      ...methodsOf.QueueEntry(),
      edit: M.call(S.Submission).returns(done),
      sendNow: M.call().returns(done),
    }),
  /** + `segments` (W2.5; m2-interfaces.md 4.8). */
  ContextSource: () =>
    M.interface('ContextSource', {
      ...foldedMethodsOf.ContextSource(),
      segments: M.call().optional(S.Cursor).returns(S.SegmentPage),
    }),
  /** + `deleteSession` (W2.7), `listBackends`, `listModels` (W2.7 for W2.2). */
  SessionFactory: () =>
    M.interface('SessionFactory', {
      ...foldedMethodsOf.SessionFactory(),
      deleteSession: M.callWhen(R('Session')).returns(done),
      listBackends: M.call().returns(list(R('Backend'), limits.maxBackends)),
      listModels: M.callWhen().optional(S.ModelRequest).returns(S.ModelPage),
    }),
  /** + data-only export and importing (W2.7). */
  HarnessRoot: () =>
    M.interface('HarnessRoot', {
      ...foldedMethodsOf.HarnessRoot(),
      exportState: M.call().optional(S.Id).returns(S.FactoryExportPage),
      importSession: M.callWhen(S.CreateOptions).returns(S.MadeSession),
    }),
  /** + `getSecrets` (W2.7 forwards to the agent host's). */
  Operator: () =>
    M.interface('Operator', {
      ...methodsOf.Operator(),
      getSecrets: M.callWhen().returns(R('SecretsAdmin')),
    }),
  /** + secrets, blob and archive release, history, import writers. */
  AgentHostAdmin: () =>
    M.interface('AgentHostAdmin', {
      ...foldedMethodsOf.AgentHostAdmin(),
      getSecrets: M.call().returns(R('SecretsAdmin')),
      releaseBlobs: M.callWhen(
        list(R('Blob'), limits.blobResolveBatch),
      ).returns(done),
      releaseArchive: M.callWhen(R('Session')).returns(done),
      history: M.callWhen().returns(R('History')),
      // No session: writers whose blobs no session owns yet (17.3: the
      // first session that presents one holds it): the factory stages a
      // composed prompt over inlineBytes before the session exists.
      writersFor: M.callWhen().optional(R('Session')).returns(R('BlobWriters')),
    }),
  /** + the catalogue (W2.2's ops; manager forwards, W2.3). */
  Backend: () =>
    M.interface('Backend', {
      ...methodsOf.Backend(),
      listModels: M.callWhen().optional(S.ModelRequest).returns(S.ModelPage),
      resolveModel: M.callWhen().optional(S.ModelId).returns(S.ResolvedModel),
    }),
  /** + `edit` (W2.4): stages an edit over inlineBytes, as `submit`. */
  Composer: () =>
    M.interface('Composer', {
      ...methodsOf.Composer(),
      edit: M.callWhen(
        R('QueueEntry'),
        M.string({ stringLengthLimit: limits.messageUnits }),
      ).returns(done),
    }),
};

// ================================================================ tables

/**
 * Every shape, by name, built on first use and kept (see `lazyTable`):
 * M1a's, M1b's and M2's. Senders' checks, tests and the gateway key guard
 * read these.
 */
export const shapes = lazyTable({
  ...m1aShapeBuilders,
  ...m1bShapeBuilders,
  ...m2ShapeBuilders,
});
/** Shorthands inside this module. */
const S = shapes;
const B = shapes;

/**
 * Every interface guard by its interface name, built on first use and kept:
 * `makeExo('Session', interfaces.Session, methods)`. Where M1b extended an
 * M1a interface this is the M1b version; M2's extensions are in
 * `m2Interfaces`.
 */
export const interfaces = lazyTable({
  ...m1aInterfaceBuilders,
  ...m1bInterfaceBuilders,
  ...m2InterfaceBuilders,
});

/**
 * M2 versions of the interfaces M2 extends. The unit that implements an M2
 * method switches that exo to the M2 guard (m2-interfaces.md 1.3).
 */
export const m2Interfaces = lazyTable(m2InterfaceBuilders2);

/** M2's new interfaces' method names. */
const m2NewMethodNames = harden({
  ArchivePort: ['seal'],
  History: ['page', 'turnContent'],
  SealedText: ['read', 'describe'],
  SecretsAdmin: ['list', 'create', 'openWriter', 'audit'],
  Secret: ['describe', 'makeReadGrant', 'revoke', 'delete', 'audit'],
  ReadGrant: ['describe'],
  SecretWriter: ['replace', 'publicKey'],
});

/**
 * Method names per interface of `interfaces`, in declaration order (the
 * gateway key guard and the docs read these; a guard's payload is not
 * reachable from the prelude).
 */
export const methodNames = harden({
  ...m1aMethodNames,
  ...m1bMethodLists,
  ...m2NewMethodNames,
});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
export const m2MethodNames = harden({
  Session: [...methodNames.Session, 'findTurn'],
  SessionInternal: [
    ...methodNames.SessionInternal,
    'blobPage',
    'deleteSelf',
    'exportState',
    'importState',
  ],
  QueueEntry: [...methodNames.QueueEntry, 'edit', 'sendNow'],
  ContextSource: [...methodNames.ContextSource, 'segments'],
  SessionFactory: [
    ...methodNames.SessionFactory,
    'deleteSession',
    'listBackends',
    'listModels',
  ],
  HarnessRoot: [...methodNames.HarnessRoot, 'exportState', 'importSession'],
  Operator: [...methodNames.Operator, 'getSecrets'],
  AgentHostAdmin: [
    ...methodNames.AgentHostAdmin,
    'getSecrets',
    'releaseBlobs',
    'releaseArchive',
    'history',
    'writersFor',
  ],
  Backend: [...methodNames.Backend, 'listModels', 'resolveModel'],
  Composer: [...methodNames.Composer, 'edit'],
});

/**
 * The M1b tables as views of the folded ones (the same shape and guard
 * objects), for modules written against them before the fold.
 */
export const m1bShapes = viewOf(Object.keys(m1bShapeBuilders), shapes);
export const m1bInterfaces = viewOf(
  Object.keys(m1bInterfaceBuilders),
  interfaces,
);
export const m1bMethodNames = m1bMethodLists;
