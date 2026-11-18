// @ts-check
/**
 * The shapes, method guards, tool names and fixed texts of mail and
 * subagents that the session program reaches (designs/m9-interfaces.md
 * sections 2 and 9). The factory's own guards (the post office, the
 * operator's mailbox, the subagent handles and the adapter's relay
 * writers) are in `./post-office.js`, which builds on this module.
 *
 * Contract artefact of M9 (W9.0). The fold unit of the M9 merge (W9.F)
 * moves every entry into the vat tables (`./session.js` for what the
 * session program reads, `./factory.js` for the rest), lists them in the
 * gateway's vocabulary through those tables, and deletes this module. Until
 * then the built tables are reached through `mailTables()` (a function, so
 * the vocabulary test does not count this module as a table before W9.8
 * lists it; `vocabulary-tables.js` seam, m9-interfaces.md 6).
 *
 * Rules (architecture 12): every string and array is bounded; no record
 * key depends on data (form fields cross as `{ name, json }` pairs, model
 * JSON as text); bodies above `inlineBytes` are StagedTexts; message
 * numbers, postmarks and sequence numbers are counts (F.2 b, e), never
 * authority: every authority here is an object.
 *
 * Runs in vats (prelude globals) and in Node after `installGuestPrelude()`.
 */
import { limits } from '../limits.js';
import { mailLimits } from '../mail-limits.js';
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
import { shapes as sessionShapes } from './session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);
const S = sessionShapes;
const ML = mailLimits;

// ---------------------------------------------------------------- names

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

// ---------------------------------------------------------------- shapes

const mailShapeBuilders = {
  MailType: () => M.or(...mailTypes),
  /** A body: inline (at most inlineBytes, checked by the sender) or staged. */
  MailBody: () => staged(text(limits.inlineBytes)),
  FormFieldKind: () => M.or(...formFieldKinds),
  /** One field of a form; `default` is JSON text of the field's kind. */
  FormField: () =>
    record(
      { name: text(ML.formFieldNameUnits), kind: X.FormFieldKind },
      {
        description: text(ML.formFieldDescriptionUnits),
        default: text(ML.formDefaultUnits),
      },
    ),
  /** One submitted value: JSON text of the field's kind (no data keys). */
  FormValue: () =>
    record({
      name: text(ML.formFieldNameUnits),
      json: text(ML.requestAnswerBytes),
    }),
  FormSubmission: () => list(X.FormValue, ML.formFields),
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
        type: X.MailType,
        from: R('MailAddress'),
        fromTitle: text(limits.titleUnits),
        body: X.MailBody,
        attachments: S.Attachments,
        at: count,
      },
      {
        inReplyTo: count,
        ticket: R('RequestTicket'),
        fields: list(X.FormField, ML.formFields),
        cutFrom: count,
      },
    ),
  /** `deliverMail`'s answer: the message number, or a refusal (no throw). */
  Delivery: () =>
    record({}, { number: count, duplicate: M.boolean(), refused: S.Reason }),
  /**
   * What a session posts (`Outbox.post`): recipients are objects (a
   * MailAddress or a SubagentHandle; anything else is refused by the post
   * office without being called).
   */
  MailDraft: () =>
    record(
      {
        to: list(M.remotable(), ML.recipientsPerSend),
        body: X.MailBody,
        attachments: S.Attachments,
      },
      { inReplyTo: count },
    ),
  /** One recipient's outcome, in `to` order. */
  PostResult: () => record({}, { postmark: count, refused: S.Reason }),
  PostReceipt: () =>
    record({ results: list(X.PostResult, ML.recipientsPerSend) }),
  /** A typed answer to a request (JSON text) or its rejection. */
  RequestAnswer: () =>
    M.or(
      record({ json: text(ML.requestAnswerBytes) }),
      record({ rejected: S.Reason }),
    ),
  /** `Delegation.spawn` argument (R4-70). */
  SpawnRequest: () =>
    record(
      {
        name: text(ML.subagentNameUnits),
        attachments: S.Attachments,
        at: count,
      },
      { systemPrompt: X.MailBody },
    ),
  SpawnAnswer: () =>
    record({ handle: R('SubagentHandle'), title: text(limits.titleUnits) }),
  /** `SubagentHandle.ask` argument (R4-72). */
  AskRequest: () =>
    record({ task: X.MailBody, attachments: S.Attachments, at: count }),
  /**
   * The answer, already cut to the tool limit by the adapter's copy
   * (`cutFrom`: the answer's length in units when cut); `edges` are the
   * reply's attachment labels, reported, never kept (R4-72).
   */
  AskAnswer: () =>
    record(
      { text: X.MailBody, edges: list(S.EdgeLabel, limits.maxAttachments) },
      { cutFrom: count },
    ),
  SubagentState: () => M.or('ready', 'asking', 'lost', 'stopping'),
  SubagentInfo: () =>
    record({
      name: text(ML.subagentNameUnits),
      handle: R('SubagentHandle'),
      state: X.SubagentState,
    }),
  /** `Delegation.children()`: a parent's live children (<= 64 by guard). */
  SubagentList: () => list(X.SubagentInfo, 64),
  /**
   * The exec vat's `splitArgs` answer: the arguments' JSON with every long
   * string replaced by a placeholder (`"\u0000s<k>"`), and the staged
   * strings in placeholder order (owned by the session).
   */
  SplitArgs: () =>
    record({
      json: text(limits.inlineBytes),
      staged: list(S.StagedText, ML.splitStagedStrings),
    }),
};

const X = lazyTable(mailShapeBuilders);

/**
 * The method guards M9 adds to `SessionInternal` (spread into its guard by
 * the W9.8 seam in `./session.js`). `deliverMail` answers a `Delivery` and
 * never throws for a full inbox; `cancelMail(postmark)` dismisses a waiting
 * message or cancels the turn handling it (an ask cancelled by its parent).
 */
const sessionInternalMailMethods = () => ({
  deliverMail: M.call(X.Envelope).returns(X.Delivery),
  cancelMail: M.call(count).returns(done),
});

/**
 * The built tables. One object per vat, built on first use (`lazyTable`).
 */
export const mailTables = () =>
  harden({ shapes: X, sessionInternalMethods: sessionInternalMailMethods });
harden(mailTables);

// ---------------------------------------------------------------- texts

/** U+2014, as Fae writes it (guest rule: ASCII outside comments). */
const DASH = '\u2014';
/** @param {string} value */
const q = value => JSON.stringify(value);

/**
 * Fixed texts. Fae's words where the source is named (1315bef86), else the
 * harness's own (journaled with the M9 contract, J-1112).
 */
export const mailTexts = harden({
  /** R4-59 (Fae session-factory.js:1617). */
  unansweredRequest: 'Agent ended the turn without a typed answer',
  /** R3-214 (daemon mail.js:1252-1258): a reply naming a postmark that was not delivered to the replier. */
  mailFraud: 'Mail fraud: unrecognized parcel',
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
  /** Harness: `send` to an object the post office did not mint (never called). */
  notAnAddress: 'The recipient is not a mail address',
  /** Harness: a settled or cancelled request answered again. */
  requestClosed: 'This request is already settled or was cancelled',
  /** Harness (R4-49 style): an ask the parent's cancel abandoned. */
  askAbandoned:
    "Subagent ask abandoned: the turn was cancelled; the subagent's turn was cancelled too",
  /** Fae subagent.js askTool: an answer cut at `answerUnits`. */
  answerTruncated: '\n\n(truncated)',
});

/** Fixed texts with parameters; each returns the exact string. */
export const mailTextOf = harden({
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
  /** @param {number} limit */
  operatorInboxFull: limit =>
    `The operator's inbox is full (${limit} messages); try again after the operator dismisses some`,
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
  /** @param {string} title */
  recipientLost: title =>
    `The recipient ${q(title)} stopped working (its session was lost); the message was not delivered`,
  /**
   * Harness: a stray body (a reply, a value) kept inline (strayBodyBytes).
   * @param {number} units the original length
   */
  bodyCut: units =>
    `\n[Message cut from ${units} characters; only this prefix was kept]`,
  /**
   * @param {number} bytes
   * @param {number} limit
   */
  answerTooLarge: (bytes, limit) =>
    `The answer is ${bytes} bytes of JSON; the limit is ${limit}`,
  /**
   * @param {number} bytes
   * @param {number} limit
   */
  envelopeTooLarge: (bytes, limit) =>
    `The message is ${bytes} bytes with its form fields and attachment labels; the limit is ${limit}`,
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
   * R4-71 (Fae subagent-admission.js).
   * @param {number} limit
   */
  treeLimit: limit =>
    `Subagent tree limit of ${limit} reached; use existing helpers or finish the task yourself.`,
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
  /** @param {string} name */
  subagentExists: name => `A subagent named ${q(name)} already exists`,
  /** @param {string} name */
  subagentLost: name =>
    `Subagent ${q(name)} stopped working (its session was lost); stop it and spawn another`,
  /**
   * Fae subagent.js askTool, non-retaining form (R4-72).
   * @param {readonly string[]} edges
   */
  answerAttachments: edges =>
    `\n\n(System: the reply attached object(s) with edge name(s) ${edges
      .map(edge => `"${edge}"`)
      .join(
        ', ',
      )}, which this session does not retain. To keep one, ask the subagent to store it under a pet name and tell you the name.)`,
  /**
   * R4-70: a child's title.
   * @param {string} parentTitle
   * @param {string} name
   */
  childTitle: (parentTitle, name) => `${parentTitle} / ${name}`,
});
