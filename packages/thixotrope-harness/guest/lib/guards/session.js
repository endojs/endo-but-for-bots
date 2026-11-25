// @ts-check
/**
 * The guards, shapes, method names and fixed texts the session program
 * reaches beyond `./base.js` (the session vat, its tools and the queue).
 *
 * The chain and its rules: `./base.js`. The tables exported here
 * (`shapes`, `interfaces`, `methodNames`, `texts`, `textOf`) hold
 * this module's entries and those of `./base.js`, the same objects.
 */
import { limits } from '../limits.js';
import {
  text,
  list,
  record,
  count,
  staged,
  R,
  done,
  lazyTable,
} from './base.js';
import * as below from './base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

/** The record kinds compaction adds to the session log, in order of use. */
export const compactionKinds = harden([
  'compaction-started',
  'compaction',
  'compaction-skipped',
]);

/**
 * Kind letters for the archive's seal fingerprint (m2-interfaces.md 4.4
 * A1); `./session.js` spreads them into `archiveKindLetters`. Letters not
 * used by M2's kinds (`s d p r i t e v`).
 */
export const compactionKindLetters = harden([
  ['compaction-started', 'c'],
  ['compaction', 'k'],
  ['compaction-skipped', 'x'],
]);

// ---------------------------------------------------------------- texts

/**
 * The fixed texts the session vat writes itself. The skip reasons the
 * adapter produces (the plan and the summary checks) are Node-only, in
 * `AH/providers/compaction.js` `compactionSkipTexts`; the vat records
 * whichever reason it is given (`CompactionSkipped.reason`). No reason
 * quotes a provider body (R4-79).
 */
export const compactionTexts = harden({
  /** R4-50: the phase while a compaction ask is out. */
  phase: 'compacting context',
  /** The vat refused the boundary the adapter answered (contract 4.2). */
  invalidBoundary: 'Compaction skipped: the proposed boundary is not a cut',
});

// ---------------------------------------------------------------- shapes

/**
 * Shape builders for the session table; `table()` answers the table that
 * holds them (the session's `shapes`), read only when a shape is built.
 * @param {() => any} table
 */
export const contextShapeBuilders = table => ({
  /**
   * `RoundRequest.compaction` (vat -> adapter, outbound): the session asks
   * the adapter to plan and summarize before this round. `epoch` is the
   * epoch the compaction creates; `boundary` the current one; `askedAt` the
   * index of the `compaction-started` record; `startIndex` the index of the
   * current turn's `turn-started`; `floor` the lowest index a new boundary
   * may take (the archive's `sealedTo`, D-M8-4); the token figures are the
   * reading the decision used.
   */
  CompactionAsk: () =>
    record({
      epoch: count,
      boundary: count,
      askedAt: count,
      startIndex: count,
      floor: count,
      usedTokens: count,
      windowTokens: count,
      thresholdTokens: count,
    }),
  /** Recorded in the crank that sends the ask (intent before effect). */
  CompactionStarted: () => {
    const S = table();
    return record({
      kind: 'compaction-started',
      turnId: S.Id,
      round: count,
      epoch: count,
      boundary: count,
      usedTokens: count,
      windowTokens: count,
      at: count,
    });
  },
  /**
   * Recorded when the vat accepts a summary: from now on the model sees
   * `summary` (an assistant message), then `directive` when the boundary
   * lies after the current turn's `turn-started`, then the records from
   * `boundary`.
   */
  Compaction: () => {
    const S = table();
    return record(
      {
        kind: 'compaction',
        turnId: S.Id,
        round: count,
        epoch: count,
        boundary: count,
        summary: staged(S.Text),
        at: count,
      },
      { directive: staged(S.SubmissionText) },
    );
  },
  /** Recorded when the adapter or the vat refused to compact. */
  CompactionSkipped: () => {
    const S = table();
    return record({
      kind: 'compaction-skipped',
      turnId: S.Id,
      round: count,
      reason: S.Reason,
      at: count,
    });
  },
  /**
   * `TurnSink.compacted` argument (adapter -> vat). `usage` is the summary
   * call's counts; the vat adds them to the turn and ignores any `context`
   * reading in it (R4-36: charged, not continuation occupancy).
   */
  CompactionResult: () => {
    const S = table();
    return M.or(
      record(
        {
          round: count,
          at: count,
          outcome: 'done',
          boundary: count,
          summary: staged(text(limits.inlineBytes)),
        },
        { usage: S.Usage, servedBy: S.ServedBy },
      ),
      record(
        { round: count, at: count, outcome: 'skipped', reason: S.Reason },
        { usage: S.Usage },
      ),
    );
  },
  /**
   * `TurnSink.compacted` answer (vat -> adapter). `go: false`: the turn is
   * no longer running this round; send nothing more. `go: true`: the
   * cache's next `{ base, append }` for this round (the records appended
   * since the round request, the compaction record among them).
   */
  CompactionReply: () => {
    const S = table();
    return M.or(
      record({ go: false }),
      record({
        go: true,
        base: record(
          { count, epoch: count },
          { boundary: count, archive: S.ArchiveState },
        ),
        append: list(S.TurnRecord, limits.maxAppendRecords),
      }),
    );
  },
});

/**
 * The method `TurnSink` gains (seam G-1).
 * @param {() => any} table
 */
export const contextSinkMethods = table => ({
  compacted: M.call(table().CompactionResult).returns(table().CompactionReply),
});

/** Method names added per interface. */
export const contextMethodNames = harden({ TurnSink: harden(['compacted']) });

/** Closed argument names (R3-26; Fae `image-tool.js:44-56`). */
export const viewImageArgumentNames = harden(['petName', 'path']);

/**
 * The tool as offered to the model (R3-30; Fae `image-tool.js:38-58`,
 * adapted: a held image source or a workspace, no Endo blob or mount).
 */
export const viewImageDescription = harden({
  name: 'viewImage',
  description:
    'Read a PNG, JPEG or WebP through an already-held capability and see it as image input (requires a vision-capable model). Use petName for an image source or a workspace; path is an optional array of relative file segments inside a workspace. Example: {"petName":"workspace","path":["screenshots","mobile.png"]}. Maximum 2 MiB; resize larger images first. For visual development, render in a browser, save desktop/mobile screenshots into the workspace, call viewImage, inspect browser errors, and iterate. Source code or a syntax check alone does not verify the rendered scene. This tool does not render HTML or fetch URLs.',
  parameters: JSON.stringify({
    type: 'object',
    additionalProperties: false,
    properties: {
      petName: { type: 'string', minLength: 1, maxLength: 256 },
      path: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: { type: 'string', minLength: 1, maxLength: 255 },
      },
    },
    required: ['petName'],
  }),
});

/** The argument text the vat checks before any send (Fae `image-tool.js:73`). */
export const viewImageTexts = harden({
  badPetName: 'petName must be a nonempty name of at most 256 characters',
});

// ---------------------------------------------------------------- texts

// ---------------------------------------------------------------- names

export { inspectOps } from './base.js';

/** R3-214: the message types. `definition` is not built (D-M9-11). */
export const mailTypes = harden([
  'package',
  'request',
  'form',
  'reply',
  'value',
]);
/** Types that start a turn in the recipient (R4-57, R4-58). */
export const turnStartingTypes = harden(['package', 'request', 'form']);
/** A form field's kind (R3-217 reshaped: a closed set, no patterns). */
export const formFieldKinds = harden([
  'string',
  'integer',
  'decimal',
  'boolean',
]);
/** States of an inbox message (session heap; m9-interfaces.md 2.2). */
export const inboxStates = harden(['waiting', 'handling', 'handled', 'kept']);

/** Mail tools (R3-33; A.3), static entries of the tool table. `adopt` is M5's. */
export const mailToolNames = harden([
  'listMessages',
  'send',
  'reply',
  'dismiss',
]);
/** Typed-request tools (R3-34; A.3). */
export const requestToolNames = harden([
  'resolveRequest',
  'rejectRequest',
  'submitForm',
]);
/** Subagent tools (R3-39; A.3), offered while depth < maxDepth (R4-69). */
export const subagentToolNames = harden([
  'spawnSubagent',
  'askSubagent',
  'stopSubagent',
]);

/**
 * Closed argument names (R3-26, R4-43), as Fae declares them; read with
 * `parseClosedArgs`, an unknown key refused before any record is built.
 * `spawnAttachment` is the element of `attachments`.
 */
export const mailToolArgumentNames = harden({
  listMessages: harden([]),
  send: harden(['recipient', 'strings', 'edgeNames', 'petNames']),
  reply: harden(['messageNumber', 'strings', 'edgeNames', 'petNames']),
  dismiss: harden(['messageNumber']),
  resolveRequest: harden(['messageNumber', 'value']),
  rejectRequest: harden(['messageNumber', 'reason']),
  submitForm: harden(['messageNumber', 'values']),
  spawnSubagent: harden(['name', 'systemPrompt', 'attachments']),
  askSubagent: harden(['name', 'task', 'timeoutSeconds', 'attachments']),
  stopSubagent: harden(['name']),
  attachment: harden(['name', 'petName']),
});

/** R3-39, A.3: the subagent name rule (the suffix ban dropped, D-M9-12). */
export const subagentNameSource = '^[a-z][a-z0-9-]{0,62}$';
/**
 * The label prefix under which `send` and the attachment lists name a
 * subagent's handle (`subagents/<name>`, A.3; the parent's subagents map,
 * not the label map).
 */
export const subagentLabelPrefix = 'subagents/';

/** Methods M9 adds to `SessionInternal` (held by the factory only). */
export const mailMethodNames = harden({
  SessionInternal: harden(['deliverMail', 'cancelMail']),
});

/** Object tools every session has (R3-31, R3-32), in table order. */
export const objectToolNames = harden([
  'list',
  'lookup',
  'store',
  'remove',
  'describeCapability',
  'readSources',
]);
/** Package tools (R3-8, R4-29; Fae `adopt`, `adoptTool`). */
export const packageToolNames = harden(['adopt', 'adoptTool']);
/**
 * Closed argument names of the object and package tools (R3-26), as Fae declares
 * them; `parseClosedArgs` refuses any other key with
 * `textOf.unexpectedArgument` before a record is built.
 */
export const toolArgumentNames = harden({
  list: harden([]),
  lookup: harden(['petName']),
  store: harden(['value', 'petName']),
  remove: harden(['petName']),
  describeCapability: harden(['petName', 'method']),
  readSources: harden(['petName', 'items']),
  readSourcesItem: harden(['path', 'startLine', 'lineCount', 'search']),
  adopt: harden(['messageNumber', 'edgeName', 'petName']),
  adoptTool: harden(['messageNumber', 'edgeName', 'toolName']),
});
/**
 * Labels the harness binds itself (R3-22, Fae `name()`), refused for
 * endowments, `store`, `adopt` and `powers.store`; template labels
 * (`workspace`, `shell`, ...) are refused as duplicates when held.
 */
export const reservedLabels = harden([
  'user',
  'tools',
  'subagents',
  '__proto__',
  'constructor',
  'prototype',
]);
/** `ExecPowersSource` methods the exec wrapper exposes as `powers`. */
export const powersMethodNames = harden([
  'lookup',
  'list',
  'store',
  'remove',
  'publish',
]);
/** States of a tool grant (`ToolGrantInfo.state`). */
export const grantStates = harden([
  'pending',
  'offered',
  'refused-builtin',
  'refused-duplicate',
  'refused-budget',
  'refused-schema',
  'withdrawn',
]);

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
const DASH = '\u2014';
/** @param {string} value */
const q = value => JSON.stringify(value);

/**
 * Fixed texts. Fae's words where the source is named (1315bef86), else the
 * harness's own (journaled with the M9 contract, J-1112).
 */

export const texts = harden({
  ...below.texts,
  /** R4-59 (Fae session-factory.js:1617). */
  unansweredRequest: 'Agent ended the turn without a typed answer',
  /** Fae workflow-tools.js:42. */
  expectedDecimal: 'Expected a decimal message number',
  /** Fae workflow-tools.js:46. */
  noSuchMessage: 'No such inbox message',
  /** Fae workflow-tools.js:60. */
  expectedRequest: 'Expected a request message',
  /** Fae workflow-tools.js:97. */
  expectedForm: 'Expected a form message',
  /** Fae workflow-tools.js:66, 84, 113. */
  requestAnswered: 'Request answered.',
  requestRejected: 'Request rejected.',
  formSubmitted: 'Form submitted.',
  /**
   * Harness (D-M9-21): a message that came with an imported session keeps
   * no sender address and no ticket, so it can be read and dismissed only.
   */
  imported:
    'This message came with an imported session; it can be read and dismissed, not answered',
  /** Harness (R4-49 style): an ask the parent's cancel abandoned. */
  askAbandoned:
    "Subagent ask abandoned: the turn was cancelled; the subagent's turn was cancelled too",
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
  /** Turn.resolve on a turn whose outcome is known. */
  resolveNotUnknown: 'Only a turn whose outcome is unknown can be resolved',
  /** A history cursor this session did not issue. */
  badCursor: 'Unknown history cursor',
  /** QueueEntry.describe on an entry that was claimed or cancelled. */
  entryGone: 'This message is no longer waiting',
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
  /**
   * M1b QC (J-0333, J-0390): the exec vat ran out of property names (its
   * name table is per vat and never shrinks; the engine's RangeError is
   * catchable, so the vat does not halt). The exec vat answers
   * `{ status: 'exhausted' }`; the session retires the scope.
   */
  execExhausted:
    'exec scope terminated: the exec vat ran out of property names (too many distinct keys were created); bindings from earlier calls are gone',
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

  // ---- labels, granted tools, packages (M5, m5-interfaces.md) ----
  /** An inspector call whose exec vat stopped (D-M5-2; neutral as J-9051). */
  inspectTerminated:
    "exec scope terminated while reading the object: the exec vat stopped (the object's answer was too large or malformed, or its worker failed); bindings from earlier calls are gone",
  /** A granted tool's grant after `withdraw()`. */
  grantWithdrawn: 'This tool grant was withdrawn',
  /** `SessionGrants.grantTool` with `maxGrantedTools` grants kept. */
  grantsFull: 'This session already has 32 granted tools; withdraw one first',
  /** The R4-29 line's closing sentence (Fae `session-attachments.js`). */
  packageDismissed: 'The package is dismissed after the turn.',
  /**
   * The browser's mention addon on a resend whose chips a page reload lost
   * (W5.8; `m5-interfaces.md` 4.1 item 2). The UI keeps a copy in
   * `ui/src/mentions/` and a unit test keeps the two equal.
   */
  attachmentsLost:
    'Attachments were lost when the page reloaded; attach them again',

  // ---- environments (designs/m6-interfaces.md 15.1; WX.1) ----
  /** Fae `assertSessionAdmission`: a stopped or stopping session refuses work. */
  sessionStopped:
    'Session is stopped or stopping; explicitly resume it in Settings',
  /** `Session.emergencyStop` of a session without a shell environment. */
  noEnvironmentToStop: 'This session has no shell environment to stop',
  /** Fae `resumeSession`. */
  finishStopFirst: 'Finish emergency stop before resuming',
  /** Fae `emergencyStop`. */
  stopIncomplete: 'Session stop incomplete; retry in Settings',
  commandOutcomeUnknown:
    "The command's outcome is unknown: the environment runner restarted while it ran. Inspect the workspace before retrying.",
  commandStopped:
    'The turn was cancelled; the environment was stopped while this command ran. Its effects may have happened.',
  /**
   * Harness (WX.1): a method whose guard the cross-lane seam unit added
   * before the lane that builds it merged (`SessionInternal.deliverMail`,
   * `Operator.getMail`, `Operator.getVoice`). Unused once those lanes
   * merged; the group fold deletes it.
   */
  notBuiltYet: 'This harness does not provide this yet',
  /**
   * M11 (m11-interfaces.md 9.1): the note a turn whose message was sent
   * from spoken mode adds to its system prompt, after any other note. The
   * three rules are the spoken introduction's (`prompt-sections.js`
   * `flootIntroduction(true)`), word for word.
   */
  spokenTurnNote: `The user spoke this message and it was transcribed, so it may contain transcription errors (misheard, missing or extra words, odd punctuation); answer what they meant. Your reply will be read aloud, so:
- Keep responses short and conversational ${DASH} usually one to three sentences.
- Avoid markdown, code blocks, bullet lists, and emoji; write as you would speak.
- Answer directly. Speak plain summaries; never read code, secrets, or raw tool output aloud.`,
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
  // The context window's kinds (seam G-1).
  ...compactionKindLetters,
]);

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  ...below.textOf,
  /**
   * R4-58 (Fae session-factory.js:1736-1741): the note after a package's
   * text when it attaches objects.
   * @param {number} number
   * @param {readonly string[]} edges
   */
  packageNote: (number, edges) =>
    `\n\n(System: message #${number} attaches object(s) with edge name(s) ${edges
      .map(edge => `"${edge}"`)
      .join(
        ', ',
      )}. To keep any of them, call the adopt tool with message number ${number} and the edge name during this turn ${DASH} the message is dismissed afterward.)`,
  /**
   * R4-58 (Fae session-factory.js:1742-1748): a request's or a form's turn
   * text.
   * @param {'request' | 'form'} type
   * @param {number} number
   * @param {string} description
   * @param {readonly string[]} fieldNames
   */
  requestTurnText: (type, number, description, fieldNames) =>
    `[Inbox ${type} #${number}] ${description}\n\n${
      type === 'request'
        ? `Answer with resolveRequest(messageNumber: "${number}", value: ...), or rejectRequest. A prose reply does not answer this request.`
        : `Answer with submitForm(messageNumber: "${number}", values: ...). Fields: ${fieldNames.join(', ')}.`
    }`,
  /**
   * Fae tool-makers.js:1023 (`send`).
   * @param {string} recipient the label the model gave
   */
  sent: recipient => `Sent message to "${recipient}"`,
  /**
   * Fae tool-makers.js:1097 (`reply`).
   * @param {number} number
   */
  replied: number => `Replied to message #${number}`,
  /** @param {number} number */
  dismissed: number => `Dismissed message #${number}`,
  /**
   * Harness: `dismiss` of a message whose turn has not run.
   * @param {number} number
   */
  dismissUnhandled: number =>
    `Message #${number} has not been handled yet; it starts its own turn`,
  /**
   * Harness (G-13 bound): the recipient's inbox is full; nothing was dropped.
   * @param {number} limit
   */
  inboxFull: limit =>
    `The recipient's inbox is full (${limit} messages); it must handle or dismiss some first`,
  /**
   * @param {number} units
   * @param {number} limit
   */
  bodyTooLong: (units, limit) =>
    `The message text is ${units} characters; the limit is ${limit}`,
  /**
   * @param {number} given
   * @param {number} limit
   */
  tooManyRecipients: (given, limit) =>
    `A message may go to at most ${limit} recipients (got ${given})`,
  /** @param {string} label */
  unknownRecipient: label =>
    `No mail recipient is held under the petname ${q(label)}`,
  /**
   * @param {number} bytes
   * @param {number} limit
   */
  answerTooLarge: (bytes, limit) =>
    `The answer is ${bytes} bytes of JSON; the limit is ${limit}`,
  /** @param {string} name */
  formFieldMissing: name => `Form field ${q(name)} is required`,
  /**
   * @param {string} name
   * @param {string} kind one of formFieldKinds
   */
  formFieldKind: (name, kind) =>
    `Form field ${q(name)} must be ${
      kind === 'string'
        ? 'a string'
        : kind === 'integer'
          ? 'a whole number'
          : kind === 'decimal'
            ? 'a decimal string of digits'
            : 'true or false'
    }`,

  // ---- subagents ----
  /**
   * Fae subagent.js:159.
   * @param {string} name
   */
  nameInvalid: name =>
    `Agent name ${q(name)} must match ${q(subagentNameSource)}`,
  /**
   * Fae subagent.js:600.
   * @param {number} max
   */
  taskInvalid: max =>
    `Subagent task must be a non-empty string of at most ${q(String(max))} characters`,
  /**
   * Fae subagent.js:604.
   * @param {number} min
   * @param {number} max
   */
  timeoutInvalid: (min, max) =>
    `Subagent timeout must be a whole number of seconds between ${q(String(min))} and ${q(String(max))}`,
  /**
   * Fae subagent.js:606.
   * @param {string} name
   */
  askInFlight: name => `Subagent ${q(name)} already has a question in flight`,
  /**
   * Fae subagent.js:647.
   * @param {string} name
   */
  noSubagent: name => `No subagent named ${q(name)} ${DASH} spawn it first`,
  /**
   * Fae subagent.js:679.
   * @param {string} name
   * @param {number} seconds
   */
  askTimeout: (name, seconds) =>
    `Subagent ${q(name)} did not reply within ${q(String(seconds))} seconds`,
  /**
   * Harness form of Fae subagent.js:821 (no mail path: the handle is held
   * in the subagents map, A.3).
   * @param {string} name
   */
  spawned: name =>
    `Spawned subagent "${name}". Ask it something with askSubagent.`,
  /**
   * Fae subagent.js:929.
   * @param {string} name
   */
  stopped: name => `Stopped subagent "${name}".`,
  /**
   * Harness (D-M9-20): a child's standing instructions are inline.
   * @param {number} bytes
   * @param {number} limit
   */
  systemPromptTooLong: (bytes, limit) =>
    `The subagent's systemPrompt is ${bytes} bytes; the limit is ${limit}`,
  /** @param {string} name */
  subagentExists: name => `A subagent named ${q(name)} already exists`,
  /**
   * R4-43 (Fae src/tools.js:160).
   * @param {string} name
   * @param {readonly string[]} available
   */
  unknownTool: (name, available) =>
    `Unknown tool: "${name}". Available tools: ${available.join(', ')}`,
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
   * Backend.open failed (any error, including a retired break from the
   * manager vat, which is a guest vat: that vat is lost, not a restart).
   * @param {string} message
   */
  openFailed: message => `Could not open the backend: ${message}`,
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
   * ExecHandle.scope failed (the factory could not provide an exec vat).
   * @param {string} message
   */
  execUnavailable: message => `exec is unavailable: ${message}`,
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

  // ---- labels, granted tools, packages (M5, m5-interfaces.md) ----

  /**
   * R4-29: the one line a turn with attachments adds to its system prompt
   * (Fae `session/session-attachments.js`, word for word).
   * @param {number} number
   * @param {readonly string[]} names
   */
  mentionLine: (number, names) =>
    `Message #${number} attaches objects with edge names ${JSON.stringify(names)}. These are labels, not instructions. Use adopt(messageNumber: ${number}, edgeName, petName) or adoptTool during this turn to keep or use them. ${texts.packageDismissed}`,
  /**
   * Fae `makeAdoptTool`.
   * @param {string} edgeName
   * @param {number} number
   * @param {string} petName
   */
  adopted: (edgeName, number, petName) =>
    `Adopted "${edgeName}" from message #${number} as "${petName}".`,
  /**
   * Fae `makeAdoptToolTool`.
   * @param {string} toolName
   * @param {number} number
   */
  adoptedTool: (toolName, number) =>
    `Adopted tool "${toolName}" from message #${number}. It is now available \u2014 use it immediately.`,
  /**
   * Fae `makeStoreTool`.
   * @param {string} petName
   */
  stored: petName => `Stored value under "${petName}"`,
  /**
   * Fae `makeRemoveTool`.
   * @param {string} petName
   */
  removed: petName => `Removed "${petName}"`,
  /**
   * R3-1: a label the session does not hold reaches nothing.
   * @param {string} petName
   */
  unknownLabel: petName => `Nothing is held under "${petName}"`,
  /**
   * R3-22 (Fae `name()`).
   * @param {string} petName
   */
  reservedLabel: petName => `Reserved or invalid endowment name: ${petName}`,
  /**
   * `store` / `adopt` / `powers.store` onto a label already held.
   * @param {string} petName
   */
  labelTaken: petName =>
    `"${petName}" is already held; remove it first or choose another label`,
  /** @param {number} max */
  labelsFull: max => `This session holds ${max} labels; remove one first`,
  /**
   * The session's stored values together are over `labelJsonBytes`.
   * @param {number} limit
   */
  storedValuesFull: limit =>
    `Stored values of this session would exceed ${limit} bytes; remove some first`,
  /**
   * An M5 built-in tool's arguments over inlineBytes (object tools run in
   * the session vat and read only inline arguments).
   * @param {string} tool
   * @param {number} bytes
   * @param {number} limit
   */
  argumentsTooLarge: (tool, bytes, limit) =>
    `Arguments for ${tool} are too large (${bytes} bytes; limit ${limit})`,
  /**
   * @param {number} number
   */
  noPackage: number => `No message #${number} is open in this turn`,
  /**
   * @param {number} number
   * @param {string} edgeName
   */
  noEdge: (number, edgeName) =>
    `Message #${number} has no attachment "${edgeName}"`,
  /** @param {number} n */
  tooManyAttachments: n =>
    `A message carries at most ${limits.maxAttachments} attachments (${n} given)`,
  /** @param {number} units */
  packageTooLong: units =>
    `A message with attachments carries at most ${limits.packageTextUnits} characters (${units} given)`,
  /** @param {string} label */
  duplicateAttachment: label => `Two attachments are labelled "${label}"`,
  /**
   * R3-6: a granted tool may not take a built-in tool's name.
   * @param {string} name
   */
  toolNameBuiltIn: name =>
    `Tool name "${name}" belongs to a built-in tool; the granted tool is not offered`,
  /**
   * R3-6: two granted tools claim one name; neither is offered.
   * @param {string} name
   */
  toolNameDuplicate: name =>
    `Tool name "${name}" is claimed by more than one granted tool; neither is offered`,
  /** @param {string} name */
  toolOverBudget: name =>
    `Tool "${name}" was not offered this round: the round's granted tool descriptions are over their size budget`,
});

// ---------------------------------------------------------------- shapes

/**
 * M1a's shapes (W1a.0), widened in place by M1b (`staged(...)`) and M2
 * (optional fields; m2-interfaces.md 1.4). `shapes` below holds them with
 * M1b's and M2's.
 */
const m1aShapeBuilders = {
  Id: () => text(limits.idUnits),
  Label: () => text(limits.labelUnits),
  Text: () => text(limits.textUnits),
  SubmissionText: () => text(limits.submissionUnits),
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
  Activity: () => M.or('passive', 'working', 'error'),
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
  /**
   * How a submission was made (m11-interfaces.md 9.1, the spoken marker):
   * `spoken: true` for a message sent from a view in spoken mode. The
   * optional last argument of `enqueueOnce` and `enqueueMessageOnce`;
   * absent, or `spoken: false`, is a typed message.
   */
  EnqueueOptions: () => record({}, { spoken: M.boolean() }),
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
  /** Who served a round (R4-50, R4-108). */
  // M2 W2.1a: OpenRouter also names the upstream provider (R4-108).
  ServedBy: () =>
    record({ label: S.Label, modelId: S.ModelId }, { provider: S.Label }),
  TurnStarted: () =>
    record(
      {
        kind: 'turn-started',
        turnId: S.Id,
        input: staged(S.SubmissionText),
        at: count,
      },
      // M5 widening (W5.3; m5-interfaces.md 9.1 H-6): the labels of the
      // message's attachments (R3-8, R4-29), never the objects. M11
      // (m11-interfaces.md 9.1): `spoken: true` for a message sent from
      // spoken mode; absent on a typed one and on every older record.
      {
        attachments: list(
          text(limits.endowmentLabelUnits),
          limits.maxAttachments,
        ),
        spoken: true,
      },
    ),
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
      // The context window's records (seam G-1).
      S.CompactionStarted,
      S.Compaction,
      S.CompactionSkipped,
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
  // M5 widening (W5.3 for W5.1; H-6): optional data fields, no objects.
  PresetSnapshot: () =>
    record(
      { label: S.Label },
      {
        workspaceSeed: S.WorkspaceSeed,
        template: text(limits.templateKindUnits),
        instructions: text(limits.presetInstructionsUnits),
        networkPolicy: M.or('off', 'public-internet'),
        modelId: S.ModelId,
        reasoningEffort: text(limits.effortUnits),
        objects: list(
          record({
            kind: text(limits.templateKindUnits),
            label: text(limits.endowmentLabelUnits),
          }),
          limits.maxTemplateObjects,
        ),
        endowmentLabels: list(
          text(limits.endowmentLabelUnits),
          limits.maxEndowments,
        ),
        revision: count,
      },
    ),
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
  WatchSnapshot: () =>
    record(
      {
        rev: count,
        info: S.SessionInfo,
        pending: S.PendingView,
        usage: S.UsageTotals,
      },
      { current: S.TurnStatus, inventoryRevision: count },
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
      // M5 widening (W5.3 for W5.1; H-6): the preset's endowments.
      {
        execVat: M.remotable('ExecHandle'),
        endowments: list(S.MailAttachment, limits.maxEndowments),
        // Environments (m6-interfaces.md 15.1, seam S-1; WX.1).
        workspace: M.remotable('Git'),
        shell: M.remotable('Shell'),
        environment: M.remotable('EnvironmentControl'),
        // Mail and subagents (m9-interfaces.md 6.2 S9; WX.1).
        mail: R('Outbox'),
        operatorAddress: R('MailAddress'),
        subagents: R('Delegation'),
      },
    ),
  /**
   * A session's sandbox execution state (m6-interfaces.md 15.1; WX.1):
   * `Session.getExecutionState`, `emergencyStop`, `resume`, the export's
   * head page.
   */
  ExecutionState: () =>
    record({
      state: M.or('running', 'stopping', 'stopped'),
      supported: M.boolean(),
    }),
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
};

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
export const view = name => {
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
export const methodsOf = harden({
  ...below.methodsOf,
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
    // The context window (seam G-1; WX.1).
    ...contextSinkMethods(() => shapes),
  }),
  Session: () => ({
    getInfo: M.call().returns(S.SessionInfo),
    rename: M.call(text(limits.titleUnits)).returns(done),
    watch: M.call().returns(S.WatchSnapshot),
    enqueueOnce: M.call(S.Submission, text(limits.requestIdUnits), count)
      // M11 (m11-interfaces.md 9.1): the spoken marker.
      .optional(S.EnqueueOptions)
      .returns(S.Receipt),
    getSubmissionReceipt: M.call(text(limits.requestIdUnits)).returns(
      M.or(done, S.Receipt),
    ),
    listPending: M.call().returns(S.PendingView),
    startTurn: M.call(S.Submission).optional(count).returns(R('Turn')),
    getCurrentTurn: M.call().returns(M.or(done, view('CurrentTurn'))),
    getHistoryPage: M.call().optional(S.Cursor).returns(view('HistoryPage')),
    getInventoryPage: M.call()
      .optional(S.Cursor)
      .returns(
        record(
          {
            rev: count,
            rows: list(
              record(
                {
                  label: text(limits.endowmentLabelUnits),
                  kind: M.or('value', 'object', 'subagent'),
                },
                {
                  preview: text(limits.inventoryPreviewBytes),
                  truncated: M.boolean(),
                  childKey: S.Id,
                },
              ),
              limits.inventoryPageRows,
            ),
          },
          { next: S.Cursor },
        ),
      ),
    getUsage: M.call().returns(S.UsageTotals),
  }),
  SessionInternal: () => ({
    rowSnapshot: M.call().returns(S.RowPatch),
  }),
  QueueEntry: () => ({
    describe: M.call().returns(S.EntryInfo),
    cancel: M.call().returns(M.boolean()),
  }),
  Composer: () => ({
    // M5 (W5.7): the optional fourth argument carries attachments.
    submit: M.callWhen(
      R('Session'),
      M.string({ stringLengthLimit: limits.messageUnits }),
      text(limits.requestIdUnits),
    )
      .optional(S.SubmitOptions)
      .returns(S.Receipt),
  }),
});

/**
 * M1a's interface guards (W1a.0). `interfaces` below holds them with M1b's
 * (whose versions replace the M1a ones they extend) and M2's new ones.
 */
const m1aInterfaceBuilders = {
  /** What the evaluating crank of the session program returns (M1a cold create; M1b pool). */
  SpareMaker: () =>
    M.interface('SpareMaker', {
      make: M.callWhen(S.MakeArgs).returns(S.MadeSession),
    }),
};

/** M1a's method names per interface, in declaration order. */
export const m1aMethodNames = harden({
  ...below.m1aMethodNames,
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
    'getInventoryPage',
    'getUsage',
  ],
});

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

/**
 * The shell tools as offered to the model (m6-interfaces.md 15.1; WX.1):
 * agent-tools `json-tools/shell.js` at `1315bef86`, word for word, with
 * `exec` named `runCommand` and `inspect` named `inspectShell` (A.3).
 */
export const shellToolDescriptions = harden({
  runCommand: harden({
    name: 'runCommand',
    description:
      'Run an allowlisted command with a structured argv (no shell string, no interpolation). Returns { stdout, stderr, exitCode, signal, truncated }; a non-zero exitCode is data, not an error. Inspect stderr as well: pipelines may mask a failed command. Output is a bounded preview; save full logs to a file and return a short excerpt. Background processes have no persistence guarantee. Run a local test server and its browser check in the same invocation and clean up on exit. A timeout or rejection does not prove the command had no effects: inspect state before retrying.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The program to run (argv[0]); must be in the shell allowlist.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Arguments passed to the program, one array element each.',
        },
        options: {
          type: 'object',
          properties: {
            timeoutMs: {
              type: 'number',
              description:
                'Override the default invocation timeout in ms, longer or shorter. Use a positive integer up to 2147483647; omit to use inspect().timeoutMs.',
            },
          },
          description: 'Optional per-call execution options.',
        },
      },
      required: ['command', 'args'],
      additionalProperties: false,
    }),
  }),
  inspectShell: harden({
    name: 'inspectShell',
    description:
      'Report the command allowlist, default invocation timeout, and output cap. Reveals no host path.',
    parameters: JSON.stringify({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    }),
  }),
});
/** Closed argument names of the shell tools (m6-interfaces.md 15.1). */
export const shellToolArgumentNames = harden({
  runCommand: harden(['command', 'args', 'options']),
  options: harden(['timeoutMs']),
  inspectShell: harden([]),
});

/** M1b's shapes (W1b.0); in `shapes` since M2 W2.0. */
const m1bShapeBuilders = {
  /** `TurnSink.progress`: the round's whole text so far, staged; `tail` its last units. */
  Progress: () =>
    record({
      round: count,
      partial: B.StagedText,
      tail: text(limits.messagePreviewUnits),
      at: count,
    }),
  /** M2 delete hook (shape only in M1b): one page of a session's blobs. */
  BlobPage: () =>
    record(
      { blobs: list(M.remotable('Blob'), limits.blobResolveBatch) },
      { next: S.Cursor },
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
export const foldedMethodsOf = harden({
  ...below.foldedMethodsOf,
  ContextSource: () => ({
    page: M.call().optional(S.Cursor).returns(pageView('ContextPage')),
  }),
});

/** M1b's interface guards (W1b.0); in `interfaces` since M2 W2.0. */
const m1bInterfaceBuilders = {
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
};

/** M1b's method names per interface (M1a's first where M1b extends one). */
export const m1bMethodLists = harden({
  ...below.m1bMethodLists,
});

// ================================================================ M2
//
// The M2 contract (W2.0; designs/m2-interfaces.md). New shapes and new
// interfaces go into the folded tables, and so do the M2 versions of the
// interfaces M2 extends (`m2Versions`; the fold, m2-interfaces.md 1.3).

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

  // ---- delete, export and importing (m2-interfaces.md 7) ----

  /** One waiting entry as exported. */
  ExportEntry: () =>
    record(
      {
        submission: S.Submission,
        requestId: text(limits.requestIdUnits),
        at: count,
      },
      // M11 (m11-interfaces.md 9.1): the entry's spoken marker.
      { spoken: true },
    ),
  /**
   * `SessionInternal.exportState` page and `importState` chunk: one `part`
   * each, in the order head, archive, records, queue, end.
   */
  SessionExportPage: () =>
    record(
      { part: M.or('head', 'archive', 'records', 'queue', 'inbox', 'end') },
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
        // The head page's execution state (m6-interfaces.md X-E; WX.1).
        execution: S.ExecutionState,
        // An `inbox` page's messages (m9-interfaces.md S9b; WX.1).
        messages: list(S.InboxExportMessage, limits.inboxMessages),
      },
    ),
  /** `SessionInternal.importState` answer. */
  ImportProgress: () => record({ records: count, complete: M.boolean() }),
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
    { part: M.or('head', 'archive', 'records', 'queue', 'inbox', 'end') },
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
      // As `SessionExportPage` (WX.1: M6 X-E, M9 S9b).
      execution: S.ExecutionState,
      messages: list(S.InboxExportMessage, limits.inboxMessages),
    },
  );
  return importChunk;
};

/**
 * The label map, attachments, granted tools and source readers (M5,
 * `m5-interfaces.md` sections 2-5).
 */
const objectShapeBuilders = {
  // `EdgeLabel`, `Attachment`, `Attachments`: in `./base.js` since WX.1
  // (`./mail.js` reads them and `./session.js` imports `./mail.js`).
  /**
   * `Composer.submit`'s optional fourth argument: the attachments (M5) and
   * the spoken marker (M11, m11-interfaces.md 9.1).
   */
  SubmitOptions: () =>
    record({}, { attachments: S.Attachments, spoken: M.boolean() }),
  /** A stored JSON value as `ExecPowersSource` carries it: the model's text. */
  // JsonValue is shared with mail attachments in base.js.
  /** `ExecPowersSource.lookup` answer. */
  PowersValue: () => M.or(done, M.remotable(), S.JsonValue),
  /**
   * One granted tool as `SessionGrants.list` / `ToolGrant.describe` show it.
   * `label` (XC, 2.6): the display label `adoptTool` was given (its
   * `toolName`); `name` is the model-facing name from the schema.
   */
  ToolGrantInfo: () =>
    record(
      {
        grant: R('ToolGrant'),
        state: M.or(...grantStates),
        source: M.or('operator', 'adopted'),
      },
      { name: S.ToolName, reason: S.Reason, label: S.Label },
    ),
};

/** Interfaces of the label map, granted tools and source readers (M5). */
const objectInterfaceBuilders = {
  /**
   * Session vat: the session's label map as its exec vat reads it (D-11),
   * one per session. Only the exec program holds it (in its closure, never
   * in the model's scope); model code gets a per-call wrapper (rule 12.13).
   */
  ExecPowersSource: () =>
    M.interface('ExecPowersSource', {
      lookup: M.call(S.Label).returns(S.PowersValue),
      list: M.call().returns(
        list(S.Label, limits.maxLabels + limits.maxDescendants),
      ),
      store: M.call(S.Label, M.or(M.remotable(), S.JsonValue)).returns(done),
      remove: M.call(S.Label).returns(M.boolean()),
      publish: M.call(S.Label, M.remotable(), M.remotable()).returns(
        M.remotable(),
      ),
    }),
  /** Session vat: the session's granted tools (R3-6). */
  SessionGrants: () =>
    M.interface('SessionGrants', {
      grantTool: M.call(M.remotable()).returns(R('ToolGrant')),
      list: M.call().returns(list(S.ToolGrantInfo, limits.maxGrantedTools)),
    }),
  /** Session vat: one grant; `withdraw` takes effect at the next round. */
  ToolGrant: () =>
    M.interface('ToolGrant', {
      describe: M.call().returns(S.ToolGrantInfo),
      withdraw: M.call().returns(done),
    }),
  /**
   * The protocol `readSources` targets implement (not an exo M5 makes;
   * M6's `Dir` and the M5 fixture implement it). Bounded by the callee.
   */
  SourceReader: () =>
    M.interface('SourceReader', {
      read: M.callWhen(S.SourceReadRequest).returns(S.SourceReadResult),
    }),
};

/** M2 versions of the interfaces M2 extends (folded methods first). */
const m2Versions = {
  /** + `findTurn` (W2.5; m2-interfaces.md 4.9). */
  Session: () =>
    M.interface('Session', {
      ...methodsOf.Session(),
      findTurn: M.call(S.Id).returns(R('Turn')),
      // R3-8, R4-38 (A.4 `enqueueMessageOnce`): a submission with attachments.
      enqueueMessageOnce: M.call(
        S.Submission,
        text(limits.requestIdUnits),
        count,
        S.Attachments,
      )
        // M11 (m11-interfaces.md 9.1): the spoken marker.
        .optional(S.EnqueueOptions)
        .returns(S.Receipt),
      // R3-6: the session's granted tools.
      grants: M.call().returns(R('SessionGrants')),
      // Environments (m6-interfaces.md 15.1, seam S-1; WX.1).
      emergencyStop: M.callWhen().returns(S.ExecutionState),
      resume: M.callWhen().returns(S.ExecutionState),
      getExecutionState: M.call().returns(S.ExecutionState),
    }),
  /** + delete, blob paging, data-only export and importing (W2.7). */
  SessionInternal: () =>
    M.interface('SessionInternal', {
      ...methodsOf.SessionInternal(),
      blobPage: M.call().optional(S.Cursor).returns(B.BlobPage),
      deleteSelf: M.call().returns(done),
      exportState: M.call().optional(S.Cursor).returns(S.SessionExportPage),
      importState: M.call(importChunkView()).returns(S.ImportProgress),
      // Mail (m9-interfaces.md 6.2 S9; WX.1): held by the factory only.
      deliverMail: M.call(S.Envelope).returns(S.MailDelivery),
      cancelMail: M.call(count).returns(done),
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

/** Method names of the interfaces M2 and M5 added, in declaration order. */
export const m2NewMethodNames = harden({
  ...below.m2NewMethodNames,
  ExecPowersSource: powersMethodNames,
  SessionGrants: ['grantTool', 'list'],
  ToolGrant: ['describe', 'withdraw'],
  SourceReader: ['read'],
});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
export const m2VersionMethodNames = harden({
  ...below.m2VersionMethodNames,
  Session: [
    ...m1aMethodNames.Session,
    'findTurn',
    'enqueueMessageOnce',
    'grants',
    'emergencyStop',
    'resume',
    'getExecutionState',
  ],
});

// ================================================================ tables

/**
 * Every shape this module and the modules below it hold, by name, built on
 * first use and kept (see `lazyTable`).
 */
const mailShapeBuilders = {
  MailType: () => M.or(...mailTypes),
  /** A body: inline (at most inlineBytes, checked by the sender) or staged. */
  MailBody: () => staged(text(limits.inlineBytes)),
  FormFieldKind: () => M.or(...formFieldKinds),
  /** One field of a form; `default` is JSON text of the field's kind. */
  FormField: () =>
    record(
      { name: text(limits.formFieldNameUnits), kind: S.FormFieldKind },
      {
        description: text(limits.formFieldDescriptionUnits),
        default: text(limits.formDefaultUnits),
      },
    ),
  /**
   * What the post office delivers into a session (`SessionInternal.
   * deliverMail`). `seq` orders deliveries to this recipient (duplicates
   * after a re-drive are answered from the inbox's outcome ring);
   * `postmark` names the delivery for replies and asks. `from` is the
   * sender's address object, stamped by the post office (R3-214);
   * `fromTitle` its human label (F.2 a). Requests and forms carry their
   * `ticket`; forms their `fields`; a cut stray body its original length.
   */
  Envelope: () =>
    record(
      {
        seq: count,
        postmark: count,
        type: S.MailType,
        from: R('MailAddress'),
        fromTitle: text(limits.titleUnits),
        body: S.MailBody,
        attachments: below.shapes.Attachments,
        at: count,
      },
      {
        inReplyTo: count,
        ticket: R('RequestTicket'),
        fields: list(S.FormField, limits.formFields),
        cutFrom: count,
      },
    ),
  /**
   * One message of an `inbox` export page (D-M9-21): data only. The
   * sender's address, the ticket and the attachment objects belong to the
   * exporting daemon and never cross an export; `edges` are the attachment
   * labels, `postmark` kept for a later re-bind (O-M9-12). A page is bounded
   * by `frameBytes` (the exporter checks `messageBytes`), the list by the
   * inbox bound. `SessionExportPage.messages` (seam S9b) is a list of these.
   */
  InboxExportMessage: () =>
    record(
      {
        number: count,
        type: S.MailType,
        fromTitle: text(limits.titleUnits),
        body: S.MailBody,
        edges: list(below.shapes.EdgeLabel, limits.maxAttachments),
        at: count,
        state: M.or(...inboxStates),
      },
      {
        postmark: count,
        inReplyTo: count,
        fields: list(S.FormField, limits.formFields),
        cutFrom: count,
      },
    ),
  /** `deliverMail`'s answer: the message number, or a refusal (no throw). */
  MailDelivery: () =>
    record(
      {},
      { number: count, duplicate: M.boolean(), refused: below.shapes.Reason },
    ),
};

export const shapes = lazyTable(
  {
    ...m1aShapeBuilders,
    ...m1bShapeBuilders,
    ...m2ShapeBuilders,
    ...objectShapeBuilders,
    ...mailShapeBuilders,
    // The context window's shapes (seam G-1; WX.1).
    ...contextShapeBuilders(() => shapes),
  },
  below.shapes,
);
/** Shorthands inside this module. */
const S = shapes;
const B = shapes;

/**
 * Every interface guard this module and the modules below it hold, by
 * interface name, built on first use and kept. Where M1b or M2 extended an
 * interface this is the latest version (the M2 fold, m2-interfaces.md 1.3).
 */
export const interfaces = lazyTable(
  {
    ...m1aInterfaceBuilders,
    ...m1bInterfaceBuilders,
    ...m2Versions,
    ...objectInterfaceBuilders,
  },
  below.interfaces,
);

/** Method names per interface of `interfaces`, in declaration order. */
export const methodNames = harden({
  ...m1aMethodNames,
  ...m1bMethodLists,
  ...m2NewMethodNames,
  ...m2VersionMethodNames,
});
