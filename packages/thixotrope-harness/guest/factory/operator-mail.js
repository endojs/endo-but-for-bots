// @ts-check
/**
 * The operator's mail: the one `OperatorMailbox` (`Operator.getMail()`),
 * the operator's inbox of `OperatorMessage` objects, and the operator's
 * requests and forms with their `RequestTicket` (the recipient's side) and
 * `RequestHandle` (the operator's side) (designs/m9-interfaces.md D-M9-9,
 * 3.1, 4.5).
 *
 * Everything the operator sends goes through the post office's `post`
 * with the operator as sender; mail to the operator arrives through the
 * `deliver` this module registers with the post office.
 *
 * - The inbox holds at most `operatorInboxMessages`; a delivery past it is
 *   refused with `operatorInboxFull` (nothing is dropped). `dismiss`
 *   releases a staged body (the post office's relay copy).
 * - A request or form is posted with a ticket; the ticket answers once
 *   (`requestClosed` after). `whenSettled()` is the durable promise of
 *   R3-216. A `responseKey` answers the handle of an open or settled
 *   request with the same key (a failed or cancelled one is replaced).
 *   At most `retainedRequests` are kept: the oldest settled one goes first.
 * - A form's submission is checked again here (names among the fields,
 *   kinds by pattern, defaults applied) and posts a `value` message into
 *   the operator's inbox. Values are checked as text: no JSON is parsed
 *   in this vat (rule 12.10).
 *
 * Guest rules: prelude globals only; no clock; collections are `Map`s and
 * `Set`s, keyed by counts, records or the operator's `responseKey`.
 */
import { limits } from '../lib/limits.js';
import { mailLimits } from '../lib/mail-limits.js';
import {
  postOfficeTables,
  postOfficeTexts,
  postOfficeTextOf,
} from '../lib/guards/post-office.js';
import { mailTexts, mailTextOf } from '../lib/guards/mail.js';
import { textOf } from '../lib/guards/base.js';
import { messageBytes, utf8Bytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { RowTable } from './rows.js' */
/** @import { PostOffice } from './post-office.js' */
const { E, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

const ML = mailLimits;
/** Bytes kept free in an inbox page for the page record and its framing. */
const PAGE_OVERHEAD_BYTES = 1024;
/** The message number a request's turn text is measured with: the widest. */
const WIDEST_NUMBER = 999_999_999;

/**
 * A form value's JSON text, by the field's kind (R3-217 reshaped). The
 * `decimal` kind travels as a JSON string of digits (the request tools
 * coerce it).
 */
const kindPatterns = harden({
  // eslint-disable-next-line no-control-regex
  string: /^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"$/,
  integer: /^-?(?:0|[1-9][0-9]*)$/,
  decimal: /^"-?[0-9]+(?:\.[0-9]+)?"$/,
  boolean: /^(?:true|false)$/,
});

/**
 * @typedef {object} InboxEntry
 * @property {number} number
 * @property {string} type
 * @property {any} from the sender's MailAddress
 * @property {string} fromTitle
 * @property {any} body
 * @property {readonly { label: string, value: any }[]} attachments
 * @property {number} at
 * @property {number} [postmark] the delivery's postmark (replies name it)
 * @property {number} [inReplyTo]
 * @property {readonly { name: string, json: string }[]} [values]
 * @property {number} [cutFrom]
 * @property {any} [message] its OperatorMessage
 */

/**
 * @typedef {object} RequestRecord
 * @property {'request' | 'form'} kind
 * @property {string} state one of `requestStates`
 * @property {number} postmark
 * @property {string} description
 * @property {readonly any[]} fields
 * @property {any} address the recipient's MailAddress
 * @property {string | undefined} key the operator's responseKey
 * @property {string} [json]
 * @property {readonly { name: string, json: string }[]} [values]
 * @property {string} [reason]
 * @property {(info: any) => void} resolve
 * @property {Promise<any>} settled
 * @property {any} handle
 */

/**
 * @param {object} powers
 * @param {PostOffice} powers.postOffice
 * @param {any} powers.admin the AgentHostAdmin (`releaseBlobs`)
 * @param {RowTable} powers.rows
 */
export const makeOperatorMail = ({ postOffice, admin, rows }) => {
  // The exos' methods answer plain records; the guards check them.
  const I = /** @type {any} */ (postOfficeTables().interfaces);
  /** @type {Map<number, InboxEntry>} in number order */
  const inbox = new Map();
  let lastNumber = 0;
  let rev = 0;
  /** @type {Set<RequestRecord>} in creation order */
  const requests = new Set();
  /** @type {Map<string, RequestRecord>} */
  const byKey = new Map();

  /** @param {InboxEntry} entry */
  const viewOf = entry => {
    /** @type {Record<string, any>} */
    const view = {
      message: entry.message,
      number: entry.number,
      type: entry.type,
      from: entry.from,
      fromTitle: entry.fromTitle,
      body: entry.body,
      edges: harden(entry.attachments.map(({ label }) => label)),
      at: entry.at,
    };
    if (entry.inReplyTo !== undefined) view.inReplyTo = entry.inReplyTo;
    if (entry.values !== undefined) view.values = entry.values;
    if (entry.cutFrom !== undefined) view.cutFrom = entry.cutFrom;
    return harden(view);
  };

  /** @param {InboxEntry} entry */
  const dismiss = entry => {
    if (!inbox.delete(entry.number)) return;
    rev += 1;
    if (typeof entry.body === 'object') {
      E(admin)
        .releaseBlobs(harden([entry.body.blob]))
        .catch(() => undefined);
    }
  };

  /**
   * Record a message in the inbox, or refuse it when the inbox is full.
   * @param {Omit<InboxEntry, 'number' | 'message'>} fields
   */
  const add = fields => {
    if (inbox.size >= ML.operatorInboxMessages) {
      return harden({
        refused: postOfficeTextOf.operatorInboxFull(ML.operatorInboxMessages),
      });
    }
    lastNumber += 1;
    /** @type {InboxEntry} */
    const entry = { ...fields, number: lastNumber };
    entry.message = makeExo('OperatorMessage', I.OperatorMessage, {
      describe: () => viewOf(entry),
      /** @param {string} edge */
      take: edge => {
        const found = entry.attachments.find(({ label }) => label === edge);
        if (found === undefined) throw Error(postOfficeTexts.noAttachment);
        return found.value;
      },
      /** @param {{ body: string, attachments: readonly any[] }} reply */
      reply: ({ body, attachments }) => {
        if (entry.postmark === undefined) {
          throw Error(postOfficeTexts.mailFraud);
        }
        return postOffice.post({
          from: { operator: true },
          draft: harden({
            to: [entry.from],
            body,
            attachments,
            inReplyTo: entry.postmark,
          }),
        });
      },
      dismiss: () => {
        dismiss(entry);
        return undefined;
      },
    });
    inbox.set(entry.number, entry);
    rev += 1;
    return harden({ number: entry.number });
  };

  /**
   * Mail the post office delivers to the operator.
   * @param {any} envelope
   */
  const deliver = envelope => {
    /** @type {Omit<InboxEntry, 'number' | 'message'>} */
    const fields = {
      type: envelope.type,
      from: envelope.from,
      fromTitle: envelope.fromTitle,
      body: envelope.body,
      attachments: envelope.attachments,
      at: envelope.at,
      postmark: envelope.postmark,
    };
    if (envelope.inReplyTo !== undefined) fields.inReplyTo = envelope.inReplyTo;
    if (envelope.cutFrom !== undefined) fields.cutFrom = envelope.cutFrom;
    return add(fields);
  };
  postOffice.attachOperatorInbox(deliver);

  /** @param {RequestRecord} record */
  const infoOf = record => {
    /** @type {Record<string, any>} */
    const info = {
      kind: record.kind,
      state: record.state,
      postmark: record.postmark,
    };
    if (record.json !== undefined) info.json = record.json;
    if (record.values !== undefined) info.values = record.values;
    if (record.reason !== undefined) info.reason = record.reason;
    return harden(info);
  };

  /**
   * @param {RequestRecord} record
   * @param {Record<string, any>} outcome
   */
  const settle = (record, outcome) => {
    Object.assign(record, outcome);
    record.resolve(infoOf(record));
  };

  /** @param {RequestRecord} record */
  const isOpen = record => record.state === 'open';

  /**
   * Room for one more request: the oldest settled one goes.
   */
  const makeRoom = () => {
    if (requests.size < ML.retainedRequests) return;
    for (const record of requests) {
      if (!isOpen(record)) {
        requests.delete(record);
        if (record.key !== undefined && byKey.get(record.key) === record) {
          byKey.delete(record.key);
        }
        return;
      }
    }
    throw Error(postOfficeTextOf.postOfficeBusy(ML.retainedRequests));
  };

  /**
   * A submission checked against the form's fields: names among them, each
   * once, kinds by pattern; a missing field takes its default.
   * @param {RequestRecord} record
   * @param {readonly { name: string, json: string }[]} values
   */
  const checkValues = (record, values) => {
    const names = record.fields.map(field => field.name);
    /** @type {Map<string, string>} */
    const given = new Map();
    for (const { name, json } of values) {
      if (!names.includes(name) || given.has(name)) {
        throw Error(textOf.unexpectedArgument(name, 'submitForm', names));
      }
      given.set(name, json);
    }
    const checked = record.fields.map(field => {
      const json = given.get(field.name) ?? field.default;
      if (json === undefined) {
        throw Error(mailTextOf.formFieldMissing(field.name));
      }
      const pattern = /** @type {Record<string, RegExp>} */ (kindPatterns)[
        field.kind
      ];
      if (!pattern.test(json)) {
        throw Error(mailTextOf.formFieldKind(field.name, field.kind));
      }
      return harden({ name: field.name, json });
    });
    const bytes = messageBytes(checked);
    if (bytes > ML.envelopeBytes) {
      throw Error(postOfficeTextOf.envelopeTooLarge(bytes, ML.envelopeBytes));
    }
    return harden(checked);
  };

  /**
   * The recipient's address of a request: a Session of this harness or a
   * session's MailAddress.
   * @param {any} to
   */
  const sessionAddressOf = to => {
    const row = rows.ofSession(to);
    const address = row === undefined ? to : postOffice.addressFor(row);
    const party = postOffice.recipientOf(address);
    if (party === undefined) throw Error(postOfficeTexts.notAnAddress);
    if (!('row' in party)) throw Error(postOfficeTexts.notASession);
    return { address, row: party.row };
  };

  /**
   * `request` and `form` (4.5).
   * @param {'request' | 'form'} kind
   * @param {any} draft
   */
  const ask = async (kind, draft) => {
    const key = draft.responseKey;
    if (key !== undefined) {
      const known = byKey.get(key);
      if (
        known !== undefined &&
        known.state !== 'failed' &&
        known.state !== 'cancelled'
      ) {
        return known.handle;
      }
    }
    const { address, row } = sessionAddressOf(draft.to);
    const fields = kind === 'form' ? draft.fields : harden([]);
    const turnText = mailTextOf.requestTurnText(
      kind,
      WIDEST_NUMBER,
      draft.description,
      fields.map((/** @type {any} */ field) => field.name),
    );
    const turnBytes = utf8Bytes(turnText);
    if (turnBytes > limits.inlineBytes) {
      throw Error(
        postOfficeTextOf.envelopeTooLarge(turnBytes, limits.inlineBytes),
      );
    }
    makeRoom();
    const { promise, resolve } = makePromiseKit();
    /** @type {RequestRecord} */
    const record = {
      kind,
      state: 'open',
      postmark: 0,
      description: draft.description,
      fields,
      address,
      key,
      resolve,
      settled: promise,
      handle: undefined,
    };
    const ticket = makeExo('RequestTicket', I.RequestTicket, {
      describe: () => harden({ kind: record.kind, state: record.state }),
      /** @param {{ json?: string, rejected?: string }} answer */
      answer: answer => {
        if (!isOpen(record)) throw Error(postOfficeTexts.requestClosed);
        if (answer.json !== undefined) {
          if (kind !== 'request') throw Error(mailTexts.expectedRequest);
          settle(record, { state: 'answered', json: answer.json });
        } else {
          settle(record, { state: 'rejected', reason: answer.rejected });
        }
        return undefined;
      },
      /** @param {readonly { name: string, json: string }[]} values */
      submit: values => {
        if (!isOpen(record)) throw Error(postOfficeTexts.requestClosed);
        if (kind !== 'form') throw Error(mailTexts.expectedForm);
        const checked = checkValues(record, values);
        settle(record, { state: 'submitted', values: checked });
        // The values are the handle's; a full inbox only drops the copy.
        add({
          type: 'value',
          from: address,
          fromTitle: row.title.slice(0, limits.titleUnits),
          body: record.description,
          attachments: harden([]),
          at: postOffice.now(),
          inReplyTo: record.postmark,
          values: checked,
        });
        return undefined;
      },
    });
    record.handle = makeExo('RequestHandle', I.RequestHandle, {
      describe: () => infoOf(record),
      whenSettled: () => record.settled,
      cancel: () => {
        if (!isOpen(record)) return undefined;
        settle(record, {
          state: 'cancelled',
          reason: postOfficeTexts.requestCancelled,
        });
        if (record.postmark !== 0) postOffice.cancelDelivery(record.postmark);
        return undefined;
      },
    });
    requests.add(record);
    if (key !== undefined) byKey.set(key, record);
    /** @type {any} */
    let receipt;
    try {
      receipt = await postOffice.post({
        from: { operator: true },
        draft: harden({
          to: [address],
          body: draft.description,
          attachments: harden([]),
        }),
        type: kind,
        ticket,
        fields: kind === 'form' ? fields : undefined,
      });
    } catch (error) {
      // Refused as a whole (the envelope's size): nothing was delivered.
      requests.delete(record);
      if (key !== undefined && byKey.get(key) === record) byKey.delete(key);
      throw error;
    }
    const [result] = receipt.results;
    if (result.refused !== undefined) {
      if (isOpen(record)) {
        const lost = row.dropped || row.state === 'lost';
        settle(record, {
          state: 'failed',
          reason: lost
            ? postOfficeTextOf.requestFailed(row.title)
            : result.refused,
        });
      }
    } else {
      record.postmark = result.postmark;
    }
    return record.handle;
  };

  /**
   * A page of the inbox in number order: at most `limit` rows (at most
   * `operatorPageRows`) and at most `frameBytes` in all.
   * @param {{ after?: number, limit?: number }} [options]
   * @returns {{ messages: any[], rev: number, next?: number }}
   */
  const list = ({ after = 0, limit = ML.operatorPageRows } = {}) => {
    const most = Math.max(1, Math.min(limit, ML.operatorPageRows));
    /** @type {any[]} */
    const messages = [];
    let bytes = PAGE_OVERHEAD_BYTES;
    let more = false;
    for (const entry of inbox.values()) {
      if (entry.number > after) {
        if (messages.length >= most) {
          more = true;
          break;
        }
        const view = viewOf(entry);
        const size = messageBytes(view);
        if (messages.length > 0 && bytes + size > limits.frameBytes) {
          more = true;
          break;
        }
        bytes += size;
        messages.push(view);
      }
    }
    return more
      ? harden({ messages, rev, next: messages[messages.length - 1].number })
      : harden({ messages, rev });
  };

  const mailbox = makeExo('OperatorMailbox', I.OperatorMailbox, {
    /** @param {any} draft */
    send: draft => {
      /** @type {Record<string, any>} */
      const normal = {
        to: harden(
          draft.to.map((/** @type {any} */ to) => {
            const row = rows.ofSession(to);
            return row === undefined ? to : postOffice.addressFor(row);
          }),
        ),
        body: draft.body,
        attachments: draft.attachments,
      };
      if (draft.inReplyTo !== undefined) normal.inReplyTo = draft.inReplyTo;
      return postOffice.post({
        from: { operator: true },
        draft: harden(normal),
      });
    },
    /** @param {any} draft */
    request: draft => ask('request', draft),
    /** @param {any} draft */
    form: draft => ask('form', draft),
    /** @param {{ after?: number, limit?: number }} [options] */
    list: options => list(options),
    rev: () => rev,
    /** @param {any} session */
    addressOf: session => {
      const row = rows.ofSession(session);
      if (row === undefined) throw Error(postOfficeTexts.notASession);
      return postOffice.addressFor(row);
    },
  });

  return harden({
    mailbox,
    deliver,
    /** Sizes (tests, status). */
    status: () => harden({ inbox: inbox.size, requests: requests.size, rev }),
  });
};
harden(makeOperatorMail);

/** @typedef {ReturnType<typeof makeOperatorMail>} OperatorMail */
