// @ts-check
/**
 * The guards of the objects the factory vat mints for mail and subagents
 * (the post office, a session's outbox and delegation facet, request
 * tickets, subagent handles, the operator's mailbox) and of the agent-host
 * adapter's relay writers (designs/m9-interfaces.md section 2). Built on
 * `./mail.js` (the shapes the session program shares).
 *
 * Contract artefact of M9 (W9.0). The fold unit of the M9 merge (W9.F)
 * moves these entries into `./factory.js` (factory exos, the `Operator`
 * extension) and the Node-side table (`RelayWriters`), and deletes this
 * module. Until then they are reached through `postOfficeTables()` (a
 * function: see `./mail.js`).
 *
 * Every remotable here is minted by harness code (the factory program or
 * the agent-host adapter), so a session vat may make answered calls to it
 * (D-M5-2 concerns objects the harness did not mint; D-M9-3).
 *
 * Runs in vats (prelude globals) and in Node after `installGuestPrelude()`.
 */
import { limits } from '../limits.js';
import { mailLimits } from '../mail-limits.js';
import { text, list, record, count, R, done, lazyTable } from './base.js';
import { shapes as sessionShapes } from './session.js';
import { mailTables } from './mail.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);
const S = sessionShapes;
const ML = mailLimits;
const X = mailTables().shapes;

// ---------------------------------------------------------------- names

/** What a MailAddress designates (`describe().kind`). */
export const addressKinds = harden(['session', 'operator', 'subagent']);
/** States of an operator request or form (`RequestInfo.state`). */
export const requestStates = harden([
  'open',
  'answered',
  'rejected',
  'submitted',
  'cancelled',
  'failed',
]);

/** Method names per interface, in declaration order. */
export const postOfficeMethodNames = harden({
  MailAddress: harden(['describe']),
  Outbox: harden(['post']),
  RequestTicket: harden(['describe', 'answer', 'submit']),
  OperatorMailbox: harden([
    'send',
    'request',
    'form',
    'list',
    'rev',
    'addressOf',
  ]),
  OperatorMessage: harden(['describe', 'take', 'reply', 'dismiss']),
  RequestHandle: harden(['describe', 'whenSettled', 'cancel']),
  Delegation: harden(['spawn', 'children']),
  SubagentHandle: harden(['describe', 'ask', 'cancelAsk', 'stop']),
  RelayWriters: harden(['open', 'copy']),
  /** The method M9 adds to `Operator` (seam in `./factory.js`). */
  Operator: harden(['getMail']),
});

// ---------------------------------------------------------------- shapes

const postOfficeShapeBuilders = {
  AddressKind: () => M.or(...addressKinds),
  AddressInfo: () =>
    record({ title: text(limits.titleUnits), kind: P.AddressKind }),
  RequestState: () => M.or(...requestStates),
  /** What a request ticket tells the session that holds it. */
  TicketInfo: () =>
    record({ kind: M.or('request', 'form'), state: P.RequestState }),
  /**
   * The operator's message: recipients are Sessions or MailAddresses; the
   * body is inline (the operator stages nothing in M9; D-M9-9).
   */
  OperatorDraft: () =>
    record(
      {
        to: list(M.remotable(), ML.recipientsPerSend),
        body: text(limits.inlineBytes),
        attachments: S.Attachments,
      },
      { inReplyTo: count },
    ),
  /** A reply from the operator's inbox (`OperatorMessage.reply`). */
  OperatorReply: () =>
    record({ body: text(limits.inlineBytes), attachments: S.Attachments }),
  RequestDraft: () =>
    record(
      { to: M.remotable(), description: text(ML.requestDescriptionUnits) },
      { responseKey: text(ML.responseKeyUnits) },
    ),
  FormDraft: () =>
    record(
      {
        to: M.remotable(),
        description: text(ML.requestDescriptionUnits),
        fields: list(X.FormField, ML.formFields),
      },
      { responseKey: text(ML.responseKeyUnits) },
    ),
  RequestInfo: () =>
    record(
      {
        kind: M.or('request', 'form'),
        state: P.RequestState,
        postmark: count,
      },
      {
        json: text(ML.requestAnswerBytes),
        values: X.FormSubmission,
        reason: S.Reason,
      },
    ),
  /** One row of the operator's inbox. The body is read through `Content`. */
  OperatorMessageView: () =>
    record(
      {
        message: R('OperatorMessage'),
        number: count,
        type: X.MailType,
        from: R('MailAddress'),
        fromTitle: text(limits.titleUnits),
        body: X.MailBody,
        edges: list(S.EdgeLabel, limits.maxAttachments),
        at: count,
      },
      { inReplyTo: count, values: X.FormSubmission, cutFrom: count },
    ),
  PageOptions: () =>
    record(
      {},
      { after: count, limit: M.and(count, M.lte(ML.operatorPageRows)) },
    ),
  OperatorMailPage: () =>
    record(
      {
        messages: list(P.OperatorMessageView, ML.operatorPageRows),
        rev: count,
      },
      { next: count },
    ),
  SubagentDescription: () =>
    record({
      name: text(ML.subagentNameUnits),
      state: X.SubagentState,
      depth: count,
    }),
  /**
   * `RelayWriters.copy` options: `maxUnits` cuts the copy (with the R4-46
   * marker) and `prefix` is written before it; without either the file is
   * hard-linked.
   */
  CopyOptions: () => record({}, { maxUnits: count, prefix: text(1024) }),
};

const P = lazyTable(postOfficeShapeBuilders);

// ---------------------------------------------------------------- interfaces

const postOfficeInterfaceBuilders = {
  /**
   * Factory exo, one per session, per subagent and one for the operator.
   * Held by sessions (label `user`, mail `from`, attachments) and the
   * operator. The post office recognises it by rights amplification.
   */
  MailAddress: () =>
    M.interface('MailAddress', {
      describe: M.call().returns(P.AddressInfo),
    }),
  /** Factory exo, one per session (`SessionServices.mail`); binds the sender. */
  Outbox: () =>
    M.interface('Outbox', {
      post: M.callWhen(X.MailDraft).returns(X.PostReceipt),
    }),
  /** Factory exo, one per request or form, carried in its envelope. */
  RequestTicket: () =>
    M.interface('RequestTicket', {
      describe: M.call().returns(P.TicketInfo),
      answer: M.call(X.RequestAnswer).returns(done),
      submit: M.call(X.FormSubmission).returns(done),
    }),
  /** Factory exo, one (`Operator.getMail()`). */
  OperatorMailbox: () =>
    M.interface('OperatorMailbox', {
      send: M.callWhen(P.OperatorDraft).returns(X.PostReceipt),
      request: M.callWhen(P.RequestDraft).returns(R('RequestHandle')),
      form: M.callWhen(P.FormDraft).returns(R('RequestHandle')),
      list: M.call().optional(P.PageOptions).returns(P.OperatorMailPage),
      rev: M.call().returns(count),
      addressOf: M.call(R('Session')).returns(R('MailAddress')),
    }),
  /** Factory exo, one per message in the operator's inbox. */
  OperatorMessage: () =>
    M.interface('OperatorMessage', {
      describe: M.call().returns(P.OperatorMessageView),
      take: M.call(S.EdgeLabel).returns(M.remotable()),
      reply: M.callWhen(P.OperatorReply).returns(X.PostReceipt),
      dismiss: M.callWhen().returns(done),
    }),
  /** Factory exo: the operator's side of a request or form. */
  RequestHandle: () =>
    M.interface('RequestHandle', {
      describe: M.call().returns(P.RequestInfo),
      whenSettled: M.callWhen().returns(P.RequestInfo),
      cancel: M.call().returns(done),
    }),
  /**
   * Factory exo, one per session below the depth limit
   * (`SessionServices.subagents`); absent at the limit (R4-69).
   */
  Delegation: () =>
    M.interface('Delegation', {
      spawn: M.callWhen(X.SpawnRequest).returns(X.SpawnAnswer),
      children: M.call().returns(X.SubagentList),
    }),
  /** Factory exo, one per child; also a mail address of the child. */
  SubagentHandle: () =>
    M.interface('SubagentHandle', {
      describe: M.call().returns(P.SubagentDescription),
      ask: M.callWhen(X.AskRequest).returns(X.AskAnswer),
      cancelAsk: M.call().returns(done),
      stop: M.callWhen().returns(done),
    }),
  /**
   * Adapter exo answered by `AgentHostAdmin.writersFor()` with no session
   * (held by the factory only; a session's `TurnPorts.writers` stays
   * `BlobWriters` without `copy`). `copy` binds a fresh stock handle to a
   * hard link (or a cut copy) of the blob's file; the copy has no owner
   * until the first session presents it (m1b-interfaces 17.3 item 4).
   */
  RelayWriters: () =>
    M.interface('RelayWriters', {
      open: M.callWhen().returns(R('BlobWriter')),
      copy: M.callWhen(R('Blob'), P.CopyOptions).returns(S.StagedText),
    }),
};

const I = lazyTable(postOfficeInterfaceBuilders);

/** The method guard M9 adds to `Operator` (spread by the W9.8 seam). */
const operatorMailMethods = () => ({
  getMail: M.call().returns(R('OperatorMailbox')),
});

/** The built tables (one per vat, built on first use). */
export const postOfficeTables = () =>
  harden({ shapes: P, interfaces: I, operatorMethods: operatorMailMethods });
harden(postOfficeTables);

// ---------------------------------------------------------------- texts

/** The harness's own texts of the post office (J-1112). */
export const postOfficeTexts = harden({
  /** A request or form whose sender cancelled it. */
  requestCancelled: 'The request was cancelled by its sender',
  /** `addressOf` / `send` with a Session this factory did not make. */
  notASession: 'Not a session of this harness',
  /** `take` of an edge the message does not carry. */
  noEdge: 'The message has no attachment with that edge name',
});

/** Texts with parameters. */
export const postOfficeTextOf = harden({
  /** @param {number} limit */
  postOfficeBusy: limit =>
    `The post office has ${limit} deliveries in flight; try again shortly`,
  /** @param {string} title */
  requestFailed: title =>
    `The request could not be delivered: ${JSON.stringify(title)} stopped working`,
});
