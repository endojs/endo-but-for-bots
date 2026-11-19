// @ts-check
/**
 * The session's inbox: the runtime part `inbox` (designs/m9-interfaces.md
 * D-M9-5..D-M9-8, D-M9-13, D-M9-21, section 3.2).
 *
 * Messages live in one `Map<number, InboxMessage>` in number order (at most
 * `limits.inboxMessages`, waiting, handling or kept); a message never
 * crosses a vat. Its number is the packages counter's (`packages.table.
 * reserve`, D-M9-7), so `adopt` reaches its attachments under the same
 * number during its turn.
 *
 * - `deliver(envelope)`, in `SessionInternal.deliverMail`'s crank: a `seq`
 *   at or below the last one is a re-drive, answered from the outcome ring
 *   (`deliveryOutcomesKept`) with `duplicate: true`; a full inbox refuses
 *   with `mailTextOf.inboxFull`; else the message is recorded `waiting`
 *   (package, request, form) or `kept` (reply, value) and its number
 *   answered. The caller then asks the runner to claim.
 * - Hooks: `nextTurn` offers the oldest waiting message, whose `take` marks
 *   it `handling` before any record; `onClaim` opens its package and sets the
 *   turn's `systemNote`; `onSettle` posts the reply (a package), rejects an
 *   unanswered request of a completed turn, keeps what its turn did not
 *   settle, and removes what is done.
 * - `cancel(postmark)`, `views`, `get`, `dismiss`, `settleRequest` for the
 *   mail and request tools; `blobs`, `exportPage`, `importPage` for the
 *   session export (D-M9-21: data only; an imported message is `kept`,
 *   `imported`, and can be read and dismissed only).
 *
 * A message's `turnId` and the part's `handling` are the only claim state:
 * at most one turn is current, so at most one message is handling.
 *
 * Guest rules: no record key from data, every collection bounded, hooks
 * synchronous (the reply and the rejection are sends whose answers are
 * not waited for).
 */
import { textOf } from '../lib/guards/session.js';
import {
  inboxStates,
  textOf as mailTextOf,
  texts as mailTexts,
  mailTypes,
  turnStartingTypes,
} from '../lib/guards/session.js';
import { limits } from '../lib/limits.js';
import { cutText, messageBytes } from '../lib/bounded.js';
import { mailTurnInput, mailTurnNote } from '../lib/mail-text.js';
import { isStaged } from './staging.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { HookTurn, Runtime } from './runtime-parts.js' */
/** @import { InboxView } from '../lib/mail-text.js' */

const { E, Fail } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {object} InboxMessage a plain record of the part's Map
 * @property {number} number
 * @property {number} [seq] undefined for an imported message
 * @property {number} [postmark]
 * @property {string} type
 * @property {any} [from] the sender's MailAddress; undefined when imported
 * @property {string} fromTitle
 * @property {any} body inline text or a StagedText
 * @property {readonly { label: string, value: any }[]} attachments
 * @property {readonly string[]} edges the attachment labels
 * @property {number} at
 * @property {number} [inReplyTo]
 * @property {any} [ticket] a request's or form's RequestTicket
 * @property {readonly any[]} [fields]
 * @property {number} [cutFrom]
 * @property {string} state one of `inboxStates`
 * @property {string} [turnId] the turn that claimed it
 * @property {boolean} imported
 * @property {boolean} answered a request or form settled by a tool
 * @property {boolean} cancelled its sender cancelled it while handling
 */

/** Bytes kept free in an export page for its own keys (as export.js). */
const PAGE_SLACK = 2048;

/** A send whose answer nobody waits for must not reject unhandled. */
const ignore = () => {};

/**
 * @param {Runtime} runtime
 */
const makeInbox = runtime => {
  /** @type {Map<number, InboxMessage>} */
  const messages = new Map();
  /** @type {Map<number, any>} delivery outcomes by seq, oldest first (a ring) */
  const outcomes = new Map();
  let lastSeq = 0;
  /** The highest imported number: the counter resumes above it. */
  let floor = 0;
  /** @type {InboxMessage | undefined} */
  let handling;

  // The packages part is made before this one; reached at run time.
  const packages = () => runtime.packages.table;

  /**
   * @param {number} seq
   * @param {any} outcome
   */
  const remember = (seq, outcome) => {
    outcomes.set(seq, outcome);
    if (outcomes.size > limits.deliveryOutcomesKept) {
      outcomes.delete(/** @type {number} */ (outcomes.keys().next().value));
    }
    return outcome;
  };

  /**
   * Records a message from an envelope or an export item: their shared
   * fields, then `own` (what only a delivery or only an import has).
   * @param {number} number
   * @param {any} item
   * @param {Record<string, any>} own
   */
  const add = (number, item, own) => {
    messages.set(
      number,
      /** @type {InboxMessage} */ ({
        number,
        postmark: item.postmark,
        type: item.type,
        fromTitle: item.fromTitle,
        body: item.body,
        at: item.at,
        inReplyTo: item.inReplyTo,
        fields: item.fields,
        cutFrom: item.cutFrom,
        answered: false,
        cancelled: false,
        ...own,
      }),
    );
  };

  /** @param {any} envelope an `Envelope` (checked by the method guard) */
  const deliver = envelope => {
    /** @type {number} */
    const seq = envelope.seq;
    if (seq <= lastSeq) {
      return harden({ ...outcomes.get(seq), duplicate: true });
    }
    lastSeq = seq;
    if (messages.size >= limits.inboxMessages) {
      return remember(
        seq,
        harden({ refused: mailTextOf.inboxFull(limits.inboxMessages) }),
      );
    }
    const number = packages().reserve(floor);
    const { attachments, type } = envelope;
    add(number, envelope, {
      seq,
      from: envelope.from,
      ticket: envelope.ticket,
      attachments,
      edges: harden(attachments.map((/** @type {any} */ a) => a.label)),
      state: turnStartingTypes.includes(type) ? 'waiting' : 'kept',
      imported: false,
    });
    return remember(seq, harden({ number }));
  };

  /** @param {InboxMessage} message */
  const remove = message => {
    messages.delete(message.number);
  };

  /**
   * @param {number} postmark
   * @returns {'dismissed' | 'cancel-turn' | 'none'}
   */
  const cancel = postmark => {
    for (const message of messages.values()) {
      if (!message.imported && message.postmark === postmark) {
        if (message.state === 'handling') {
          message.cancelled = true;
          return 'cancel-turn';
        }
        remove(message);
        return 'dismissed';
      }
    }
    return 'none';
  };

  /**
   * @param {InboxMessage} message
   * @returns {InboxView}
   */
  const viewOf = ({ number, type, fromTitle, body, edges, state, at }) =>
    harden({ number, type, fromTitle, body, edges, state, at });

  /**
   * Newest first, at most `listMessagesPage`.
   * @param {{ limit?: number }} [options]
   * @returns {InboxView[]}
   */
  const views = ({ limit = limits.listMessagesPage } = {}) => {
    const all = [...messages.values()];
    const count = Math.min(limit, limits.listMessagesPage, all.length);
    /** @type {InboxView[]} */
    const out = [];
    for (let i = all.length - 1; out.length < count; i -= 1) {
      out.push(viewOf(all[i]));
    }
    return harden(out);
  };

  /** @param {number} number */
  const get = number => messages.get(number);

  /** @param {number} number */
  const dismiss = number => {
    const message = messages.get(number);
    if (message === undefined) {
      return harden({ refused: mailTexts.noSuchMessage });
    }
    if (message.state === 'waiting' || message.state === 'handling') {
      return harden({ refused: mailTextOf.dismissUnhandled(number) });
    }
    remove(message);
    return harden({ ok: true });
  };

  /**
   * Marks an open request or form answered (so a second tool call or its
   * turn's settle does not answer it again) and answers its ticket for the
   * tool to call, with `settled(sent)` for the tool to report the ticket's
   * answer: sent, a kept message is removed (a handling one goes at its
   * turn's settle); refused, the message is open again and can be retried.
   * Undefined when there is none to answer (imported, not a request,
   * already answered).
   * @param {number} number
   */
  const settleRequest = number => {
    const message = messages.get(number);
    if (
      message === undefined ||
      message.imported ||
      message.answered ||
      message.ticket === undefined
    ) {
      return undefined;
    }
    message.answered = true;
    return harden({
      ticket: message.ticket,
      /** @param {boolean} sent */
      settled: sent => {
        if (!sent) message.answered = false;
        else if (message.state === 'kept') remove(message);
      },
    });
  };

  /** Staged bodies the inbox holds (the session's blob pages list them). */
  const blobs = () => {
    /** @type {any[]} */
    const out = [];
    for (const { body } of messages.values()) {
      if (isStaged(body)) out.push(body);
    }
    return harden(out);
  };

  /** @param {InboxMessage} message */
  const exportOf = message => {
    /** @type {Record<string, any>} */
    const item = {
      number: message.number,
      type: message.type,
      fromTitle: message.fromTitle,
      body: message.body,
      edges: message.edges,
      at: message.at,
      state: message.state,
    };
    const { postmark, inReplyTo, fields, cutFrom } = message;
    if (postmark !== undefined) item.postmark = postmark;
    if (inReplyTo !== undefined) item.inReplyTo = inReplyTo;
    if (fields !== undefined) item.fields = fields;
    if (cutFrom !== undefined) item.cutFrom = cutFrom;
    return harden(item);
  };

  /**
   * One `inbox` export page: the messages numbered `from` on, within
   * `frameBytes`; `next` resumes, or is the end cursor.
   * @param {number} from
   */
  const exportPage = from => {
    /** @type {any[]} */
    const page = [];
    let bytes = PAGE_SLACK;
    let next = 'e';
    for (const message of messages.values()) {
      if (message.number >= from) {
        const item = exportOf(message);
        const size = messageBytes(item);
        if (page.length > 0 && bytes + size > limits.frameBytes) {
          next = `m${message.number}`;
          break;
        }
        bytes += size;
        page.push(item);
      }
    }
    return harden({ part: 'inbox', messages: page, next });
  };

  /**
   * One `inbox` import page into a new session: every message `kept` and
   * read-only. A page already applied is applied again without effect.
   * @param {any} chunk a `SessionExportPage` (checked by the guard)
   */
  const importPage = chunk => {
    lastSeq === 0 || Fail`only a new session imports mail`;
    messageBytes(chunk) <= limits.frameBytes ||
      Fail`an inbox page over frameBytes`;
    for (const item of chunk.messages ?? []) {
      const { type, state } = item;
      /** @type {number} */
      const number = item.number;
      (mailTypes.includes(type) && inboxStates.includes(state)) ||
        Fail`not an inbox message: ${type} ${state}`;
      const known = messages.get(number);
      if (known !== undefined) {
        // A page sent again: applied once.
        known.imported || Fail`only a new session imports mail`;
      } else {
        messages.size < limits.inboxMessages ||
          Fail`an imported inbox holds at most ${limits.inboxMessages}`;
        add(number, item, {
          attachments: harden([]),
          edges: item.edges,
          state: 'kept',
          imported: true,
        });
        if (number > floor) floor = number;
      }
    }
    // The packages counter resumes above every imported number (D-M9-21),
    // so a package opened before the next delivery cannot reuse one
    // (`reserve(floor - 1)` sets a new session's counter to `floor`).
    if (floor > 0) packages().reserve(floor - 1);
  };

  // ---------------------------------------------------------------- hooks

  const nextTurn = () => {
    for (const message of messages.values()) {
      if (message.state === 'waiting') {
        return harden({
          text: mailTurnInput(message),
          at: message.at,
          take: (/** @type {{ turnId: string }} */ info) => {
            message.state = 'handling';
            message.turnId = info.turnId;
            handling = message;
          },
        });
      }
    }
    return undefined;
  };

  /** @param {HookTurn} turn */
  const onClaim = ({ active }) => {
    const message = handling;
    if (message === undefined || message.turnId !== active.turnId) return;
    const { attachments, edges, number } = message;
    if (attachments.length === 0) return;
    packages().open({
      number,
      labels: edges,
      values: new Map(attachments.map(a => [a.label, a.value])),
      turnId: active.turnId,
    });
    active.systemNote = mailTurnNote(message);
  };

  /**
   * The text a settled turn answers its sender with: the final text when
   * completed (an inline one cut to `inlineBytes`), else `Error: ...`.
   * @param {HookTurn} turn
   */
  const replyBody = turn => {
    const { active } = turn;
    if (active.state === 'completed') {
      const final = turn.final ?? '';
      return typeof final === 'string'
        ? cutText(final, limits.inlineBytes)
        : final;
    }
    return textOf.errorResult(active.info.error ?? active.state);
  };

  /** @param {HookTurn} turn */
  const onSettle = turn => {
    const message = handling;
    if (message === undefined || message.turnId !== turn.active.turnId) return;
    handling = undefined;
    const completed = turn.active.state === 'completed';
    const { mail } = runtime.services;
    if (message.type === 'package') {
      if (mail !== undefined) {
        E(mail)
          .post(
            harden({
              to: harden([message.from]),
              body: replyBody(turn),
              attachments: harden([]),
              inReplyTo: message.postmark,
            }),
          )
          .then(ignore, ignore);
      }
      remove(message);
      return;
    }
    if (message.answered || message.cancelled) {
      remove(message);
      return;
    }
    if (message.type === 'request' && completed) {
      message.answered = true;
      E(message.ticket)
        .answer(harden({ rejected: mailTexts.unansweredRequest }))
        .then(ignore, ignore);
      remove(message);
      return;
    }
    // A request whose turn failed, or any unanswered form, stays listed.
    message.state = 'kept';
  };

  return harden({
    deliver,
    cancel,
    views,
    get,
    dismiss,
    settleRequest,
    blobs,
    hasMessages: () => messages.size > 0,
    exportPage,
    importPage,
    hooks: harden({ nextTurn, onClaim, onSettle }),
  });
};

export const inboxPart = harden({
  name: /** @type {const} */ ('inbox'),
  make: makeInbox,
});
