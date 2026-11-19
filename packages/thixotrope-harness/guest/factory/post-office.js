// @ts-check
/**
 * The post office: every message between sessions, and between a session
 * and the operator, goes sender -> this factory vat -> recipient
 * (designs/m9-interfaces.md D-M9-2, 3.1, 4.1-4.3, 5).
 *
 * Objects it mints, each once per party and kept in a `WeakMap`:
 * - a `MailAddress` per session row and one for the operator;
 * - an `Outbox` per session row (`SessionServices.mail`), which binds the
 *   sender: a session can post only as itself (R3-214).
 *
 * A recipient arrives as an object of the sender's choosing. The post
 * office never calls it: it recognises a `MailAddress` (or a
 * `SubagentHandle` the subagent tree bound with `bindAddress`) by rights
 * amplification and refuses anything else with `notAnAddress` (D-M9-3).
 *
 * `post` checks the draft (a reply's postmark, the envelope's size), then
 * per recipient: the in-flight bounds (`postInFlight` rows and
 * `postInFlightBytes` of kept envelopes), a postmark, a relay copy of a
 * staged body (D-M9-4), the recipient's next `seq` and the delivery
 * (`SessionInternal.deliverMail`). Draft-level refusals (`mailFraud`,
 * `envelopeTooLarge`) reject the post; recipient-level ones are the
 * receipt's results, in `to` order. A message that starts no turn (a
 * `reply`, a `value`) to a session is kept inline: a staged body is
 * replaced by its preview and the `bodyCut` note, and no copy is made.
 *
 * Replies (`inReplyTo`) are checked against the postmark ring: the replier
 * must be the recipient the postmark was delivered to and the reply goes
 * back to its sender, else `mailFraud`. A reply to an open ask goes to the
 * ask's listener (`onReply`) and never reaches an inbox; one to a closed
 * postmark is consumed (D-M9-8).
 *
 * Restarts: each in-flight row is stamped with the daemon start it was
 * sent in; `restart(current)` re-drives every row stamped earlier, at most
 * `REDRIVE_WINDOW` at once, with the same `seq` (the recipient answers a
 * duplicate from its outcome ring) and never waits for a guest call
 * (CC-110, ARCH 4.4).
 *
 * Bounds (D-M9-13): in-flight rows and their kept bytes, the postmark ring
 * (`postmarksKept`), open asks (one per child, the subagent tree's bound).
 * No lifetime count is kept.
 *
 * Guest rules: prelude globals only; no clock (a message's `at` is the
 * caller's, else the latest time the factory knows); no data-dependent
 * keys (postmarks are counts and key `Map`s).
 */
import { limits } from '../lib/limits.js';
import { mailLimits } from '../lib/mail-limits.js';
import {
  postOfficeTables,
  postOfficeTexts,
  postOfficeTextOf,
} from '../lib/guards/post-office.js';
import { turnStartingTypes } from '../lib/guards/mail.js';
import { cutText, messageBytes, messageOf, utf8Bytes } from '../lib/bounded.js';
import { isRetiredBreak } from '../lib/retired.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Row, RowTable } from './rows.js' */
/** @import { StartCount } from './starts.js' */
const { E, makeExo, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** The title the operator's mail carries (`fromTitle`): its label in a session. */
export const OPERATOR_TITLE = 'user';
/** Deliveries one start's re-drive keeps in flight at once (5.1). */
export const REDRIVE_WINDOW = 32;

const ML = mailLimits;

/**
 * A party of a message: a session row or the operator.
 * @typedef {{ row: Row } | { operator: true }} Party
 */

/**
 * @typedef {object} PostmarkRecord
 * @property {Party} sender
 * @property {Party} recipient
 * @property {boolean} closed a closed ask: a later reply is consumed
 */

/**
 * @typedef {object} Flight one delivery posted and not yet answered
 * @property {number} postmark
 * @property {Row} row the recipient
 * @property {Record<string, any>} base the envelope without `seq`, `postmark`
 * @property {boolean} copyBody the staged body is copied for the recipient
 * @property {number} bytes kept bytes (`messageBytes` of `base`)
 * @property {number} start the daemon start it was (re-)sent in
 * @property {any} envelope the envelope as first sent (re-drives resend it)
 * @property {any} copied the relay copy in the envelope, if any
 * @property {number} attempts sends started
 * @property {boolean} done
 * @property {(result: any) => void} resolve the recipient's result
 */

/**
 * What a reply listener receives (`onReply`): the reply as posted.
 * @typedef {object} Reply
 * @property {any} body inline text or the replier's StagedText
 * @property {readonly any[]} attachments
 * @property {string} fromTitle
 * @property {number} at
 * @property {number} postmark the ask's postmark
 */

/** @param {unknown} reason */
const reasonOf = reason => messageOf(reason).slice(0, limits.reasonUnits);

/**
 * @param {Party} a
 * @param {Party} b
 */
const sameParty = (a, b) =>
  'row' in a ? 'row' in b && a.row === b.row : !('row' in b);

/**
 * A row's party. Frozen, not hardened: hardening would freeze the mutable
 * row it names.
 * @param {Row} row
 * @returns {Party}
 */
const partyOfRow = row => Object.freeze({ row });

/** @param {Row} row */
const titleOfRow = row => row.title.slice(0, limits.titleUnits);

/**
 * The contract's call also passes `settings` (the harness settings); the
 * post office reads none of them.
 * @param {object} powers
 * @param {any} powers.admin the AgentHostAdmin (`writersFor()` with no
 *   session answers the relay writers; `releaseBlobs`)
 * @param {RowTable} powers.rows
 * @param {StartCount} powers.starts
 * @param {() => number} [powers.lastKnownTime] the time a message without
 *   a caller's `at` is stamped with; by default the latest `at` seen
 */
export const makePostOffice = ({ admin, rows, starts, lastKnownTime }) => {
  const I = postOfficeTables().interfaces;
  let latestAt = 0;
  /** @param {number | undefined} at */
  const stampOf = at => {
    if (typeof at === 'number') {
      if (at > latestAt) latestAt = at;
      return at;
    }
    return lastKnownTime === undefined ? latestAt : lastKnownTime();
  };

  /** @type {Party} */
  const OPERATOR = harden({ operator: true });

  /** Address or handle -> its party (rights amplification, D-M9-2). */
  /** @type {WeakMap<object, Party>} */
  const parties = new WeakMap();
  /** @type {WeakMap<Row, any>} */
  const addressOfRow = new WeakMap();
  /** @type {WeakMap<Row, any>} */
  const outboxOfRow = new WeakMap();
  /** The last `seq` sent to each recipient row. */
  /** @type {WeakMap<Row, number>} */
  const seqs = new WeakMap();
  let operatorSeq = 0;

  /** @type {Map<number, PostmarkRecord>} the ring, oldest first */
  const postmarks = new Map();
  let lastPostmark = 0;
  /** Open asks by postmark: kept beside the ring, never evicted by it. */
  /** @type {Map<number, { record: PostmarkRecord, listener: (reply: Reply) => void }>} */
  const asks = new Map();

  /** @type {Map<number, Flight>} */
  const flights = new Map();
  let keptBytes = 0;
  const counts = { redriven: 0 };

  /** @type {((envelope: any) => any) | undefined} */
  let operatorInbox;

  /** @param {Party} party */
  const mintAddress = party => {
    const address = makeExo('MailAddress', I.MailAddress, {
      describe: () =>
        harden(
          'row' in party
            ? {
                title: titleOfRow(party.row),
                kind:
                  /** @type {any} */ (party.row).parent === undefined
                    ? 'session'
                    : 'subagent',
              }
            : { title: OPERATOR_TITLE, kind: 'operator' },
        ),
    });
    parties.set(address, party);
    return address;
  };
  const operatorAddressObject = mintAddress(OPERATOR);

  /** @param {Row} row */
  const addressFor = row => {
    let address = addressOfRow.get(row);
    if (address === undefined) {
      address = mintAddress(partyOfRow(row));
      addressOfRow.set(row, address);
    }
    return address;
  };

  /** @param {Party} party */
  const addressOfParty = party =>
    'row' in party ? addressFor(party.row) : operatorAddressObject;

  /** @param {Party} party */
  const titleOfParty = party =>
    'row' in party ? titleOfRow(party.row) : OPERATOR_TITLE;

  /** @param {any} object */
  const recipientOf = object =>
    typeof object === 'object' && object !== null
      ? parties.get(object)
      : undefined;

  /**
   * A new postmark in the ring (the oldest dropped past `postmarksKept`).
   * @param {Party} sender
   * @param {Party} recipient
   */
  const remember = (sender, recipient) => {
    lastPostmark += 1;
    postmarks.set(lastPostmark, { sender, recipient, closed: false });
    if (postmarks.size > ML.postmarksKept) {
      const oldest = postmarks.keys().next().value;
      if (oldest !== undefined) postmarks.delete(oldest);
    }
    return lastPostmark;
  };

  /** @type {Promise<any> | undefined} */
  let relay;
  const relayOf = () => {
    if (relay === undefined) relay = E(admin).writersFor();
    return relay;
  };
  /**
   * `RelayWriters.copy`; a retired break (the adapter restarted) re-fetches
   * the relay writers once, then the failure is the caller's (3.3).
   * @param {any} blob
   * @param {Record<string, any>} [options]
   */
  const copy = async (blob, options = {}) => {
    try {
      return await E(await relayOf()).copy(blob, harden(options));
    } catch (error) {
      if (!isRetiredBreak(error)) throw error;
      relay = undefined;
      return E(await relayOf()).copy(blob, harden(options));
    }
  };

  /** @param {any} staged a relay copy nothing will name */
  const release = staged => {
    E(admin)
      .releaseBlobs(harden([staged.blob]))
      .catch(() => undefined);
  };

  /**
   * @param {Flight} flight
   * @param {{ postmark: number } | { refused: string }} result
   */
  const settle = (flight, result) => {
    if (flight.done) return;
    flight.done = true;
    flights.delete(flight.postmark);
    keptBytes -= flight.bytes;
    if ('refused' in result) {
      asks.delete(flight.postmark);
      if (flight.copied !== undefined) release(flight.copied);
    }
    flight.resolve(harden(result));
  };

  /**
   * One send of a flight: the copy (first send only), then `deliverMail`.
   * A delivery answer from any send settles it; a failure settles it only
   * when no newer send began (a re-drive).
   * @param {Flight} flight
   */
  const attempt = async flight => {
    flight.attempts += 1;
    const mine = flight.attempts;
    const { row } = flight;
    try {
      if (flight.envelope === undefined) {
        let { body } = flight.base;
        /** @type {any} */
        let copied;
        if (flight.copyBody) {
          copied = await copy(body.blob);
          body = copied;
        }
        if (flight.done || flight.envelope !== undefined) {
          // Settled or sent by a newer send meanwhile: this copy is spare.
          if (copied !== undefined) release(copied);
          if (flight.done) return;
        } else {
          const seq = (seqs.get(row) ?? 0) + 1;
          seqs.set(row, seq);
          flight.copied = copied;
          flight.envelope = harden({
            ...flight.base,
            body,
            seq,
            postmark: flight.postmark,
          });
        }
      }
      const delivery = await E(row.internal).deliverMail(flight.envelope);
      settle(
        flight,
        delivery.refused === undefined
          ? { postmark: flight.postmark }
          : { refused: delivery.refused },
      );
    } catch (error) {
      if (flight.done) return;
      if (isRetiredBreak(error) && flight.envelope !== undefined) {
        // The recipient vat is lost (D-17), whichever send saw it.
        rows.markLost(row);
        settle(flight, { refused: postOfficeTextOf.recipientLost(row.title) });
        return;
      }
      if (mine !== flight.attempts) return;
      settle(flight, { refused: reasonOf(error) });
    }
  };

  /**
   * A message that starts no turn, to a session, is kept inline (3.2 rule
   * 3): a staged body becomes its preview with the `bodyCut` note.
   * @param {any} body
   */
  const strayBody = body => {
    if (typeof body === 'string') {
      if (utf8Bytes(body) <= ML.strayBodyBytes) return { body };
      // Inline bodies are at most inlineBytes; kept for a lower bound.
      const note = postOfficeTextOf.bodyCut(body.length);
      const prefix = cutText(body, ML.strayBodyBytes - utf8Bytes(note));
      return { body: `${prefix}${note}`, cutFrom: body.length };
    }
    // A StagedText: the units are not known here, so its bytes stand in.
    return {
      body: `${body.preview}${postOfficeTextOf.bodyCut(body.bytes)}`,
      cutFrom: body.bytes,
    };
  };

  /**
   * @param {Record<string, any>} base
   * @param {Party} sender
   * @param {Party} recipient
   */
  const toOperator = async (base, sender, recipient) => {
    if (operatorInbox === undefined) {
      return { refused: postOfficeTexts.notAnAddress };
    }
    const postmark = remember(sender, recipient);
    let { body } = base;
    /** @type {any} */
    let copied;
    try {
      if (typeof body === 'object') {
        copied = await copy(body.blob);
        body = copied;
      }
    } catch (error) {
      return { refused: reasonOf(error) };
    }
    operatorSeq += 1;
    const delivery = operatorInbox(
      harden({ ...base, body, seq: operatorSeq, postmark }),
    );
    if (delivery.refused !== undefined) {
      if (copied !== undefined) release(copied);
      return { refused: delivery.refused };
    }
    return { postmark };
  };

  /**
   * Admission and the start of one delivery to a session; synchronous up
   * to the returned promise, so every recipient of a post is admitted in
   * the post's crank.
   * @param {Party} sender
   * @param {Party & { row: Row }} recipient
   * @param {Record<string, any>} base
   * @param {((reply: Reply) => void) | undefined} onReply
   */
  const toSession = (sender, recipient, base, onReply) => {
    const { row } = recipient;
    if (row.dropped || row.state === 'lost' || row.internal === undefined) {
      return { refused: postOfficeTextOf.recipientLost(row.title) };
    }
    const bytes = messageBytes(base);
    if (
      flights.size >= ML.postInFlight ||
      keptBytes + bytes > ML.postInFlightBytes
    ) {
      return { refused: postOfficeTextOf.postOfficeBusy(ML.postInFlight) };
    }
    const postmark = remember(sender, recipient);
    if (onReply !== undefined) {
      const record = /** @type {PostmarkRecord} */ (postmarks.get(postmark));
      asks.set(postmark, { record, listener: onReply });
    }
    const { promise, resolve } = makePromiseKit();
    /** @type {Flight} */
    const flight = {
      postmark,
      row,
      base,
      copyBody: typeof base.body === 'object',
      bytes,
      start: starts.current(),
      envelope: undefined,
      copied: undefined,
      attempts: 0,
      done: false,
      resolve,
    };
    flights.set(postmark, flight);
    keptBytes += bytes;
    void attempt(flight);
    return promise;
  };

  /**
   * A reply (`inReplyTo`): checked against the ring, then given to the
   * ask's listener, consumed, or delivered to the original sender.
   * @param {Party} sender
   * @param {any} draft
   * @param {number} at
   */
  const postReply = async (sender, draft, at) => {
    const postmark = draft.inReplyTo;
    const ask = asks.get(postmark);
    const record = ask?.record ?? postmarks.get(postmark);
    if (record === undefined || !sameParty(record.recipient, sender)) {
      throw Error(postOfficeTexts.mailFraud);
    }
    for (const object of draft.to) {
      const party = recipientOf(object);
      if (party === undefined || !sameParty(party, record.sender)) {
        throw Error(postOfficeTexts.mailFraud);
      }
    }
    const accepted = harden(draft.to.map(() => harden({ postmark })));
    if (ask !== undefined) {
      asks.delete(postmark);
      record.closed = true;
      ask.listener(
        harden({
          body: draft.body,
          attachments: draft.attachments,
          fromTitle: titleOfParty(sender),
          at,
          postmark,
        }),
      );
      return harden({ results: accepted });
    }
    if (record.closed) return harden({ results: accepted });
    const target = record.sender;
    /** @type {Record<string, any>} */
    const base = {
      type: 'reply',
      from: addressOfParty(sender),
      fromTitle: titleOfParty(sender),
      body: draft.body,
      attachments: draft.attachments,
      at,
      inReplyTo: postmark,
    };
    if ('row' in target) {
      const kept = strayBody(draft.body);
      base.body = kept.body;
      if (kept.cutFrom !== undefined) base.cutFrom = kept.cutFrom;
    }
    checkEnvelope(base);
    const result = await ('row' in target
      ? toSession(sender, target, harden(base), undefined)
      : toOperator(harden(base), sender, target));
    // One delivery however often the sender is named.
    return harden({ results: harden(draft.to.map(() => result)) });
  };

  /** @param {Record<string, any>} base */
  const checkEnvelope = base => {
    // `seq` and `postmark` are counts: no string bytes.
    const bytes = messageBytes(base);
    if (bytes > ML.envelopeBytes) {
      throw Error(postOfficeTextOf.envelopeTooLarge(bytes, ML.envelopeBytes));
    }
  };

  /**
   * Post a draft (3.1). `type` defaults to `reply` with `inReplyTo`, else
   * `package`; `ticket` and `fields` go into a request's or form's
   * envelope; `onReply` registers an ask on each recipient's postmark
   * before its delivery is sent.
   * @param {object} post
   * @param {{ row: Row } | { operator: true }} post.from
   * @param {any} post.draft `{ to, body, attachments, inReplyTo? }`
   * @param {string} [post.type]
   * @param {any} [post.ticket]
   * @param {readonly any[]} [post.fields]
   * @param {number} [post.at]
   * @param {(reply: Reply) => void} [post.onReply]
   */
  const post = async ({ from, draft, type, ticket, fields, at, onReply }) => {
    /** @type {Party} */
    const sender = 'row' in from ? partyOfRow(from.row) : OPERATOR;
    if ('row' in sender && sender.row.dropped) {
      throw Error(postOfficeTexts.notASession);
    }
    const stamp = stampOf(at);
    if (draft.inReplyTo !== undefined) {
      return postReply(sender, draft, stamp);
    }
    const kind = type ?? 'package';
    const startsTurn = turnStartingTypes.includes(kind);
    /** @type {Record<string, any>} */
    const base = {
      type: kind,
      from: addressOfParty(sender),
      fromTitle: titleOfParty(sender),
      body: draft.body,
      attachments: draft.attachments,
      at: stamp,
    };
    if (ticket !== undefined) base.ticket = ticket;
    if (fields !== undefined) base.fields = fields;
    const full = harden({ ...base });
    /** @type {Record<string, any>} */
    const stray = { ...base };
    if (!startsTurn) {
      const kept = strayBody(draft.body);
      stray.body = kept.body;
      if (kept.cutFrom !== undefined) stray.cutFrom = kept.cutFrom;
    }
    const toSessions = harden(stray);
    checkEnvelope(full);
    checkEnvelope(toSessions);
    const results = await Promise.all(
      draft.to.map((/** @type {any} */ object) => {
        const party = recipientOf(object);
        if (party === undefined) {
          return harden({ refused: postOfficeTexts.notAnAddress });
        }
        if ('row' in party) {
          return toSession(sender, party, toSessions, onReply);
        }
        return toOperator(full, sender, party);
      }),
    );
    return harden({ results: harden(results) });
  };

  /**
   * Re-drive every delivery stamped with an earlier start, at most
   * `REDRIVE_WINDOW` at once; answers without waiting for any of them.
   * @param {number} current the start count `starts.next()` answered
   */
  const restart = async current => {
    const stale = [...flights.values()].filter(f => f.start < current);
    for (const flight of stale) flight.start = current;
    counts.redriven += stale.length;
    let next = 0;
    const launch = () => {
      if (next >= stale.length) return;
      const flight = stale[next];
      next += 1;
      void attempt(flight).finally(launch);
    };
    for (let i = 0; i < REDRIVE_WINDOW; i += 1) launch();
  };

  /**
   * A deleted session: its undelivered mail is refused with
   * `recipientLost`; its address stays recognised, so later mail to it is
   * refused the same way (acceptance 18).
   * @param {Row} row
   */
  const rowRemoved = row => {
    for (const flight of [...flights.values()]) {
      if (flight.row === row) {
        settle(flight, { refused: postOfficeTextOf.recipientLost(row.title) });
      }
    }
    seqs.delete(row);
    outboxOfRow.delete(row);
  };

  /**
   * An ask closed (timed out, cancelled, recovered): a later reply to it is
   * consumed, never delivered.
   * @param {number} postmark
   */
  const closePostmark = postmark => {
    asks.delete(postmark);
    const record = postmarks.get(postmark);
    if (record !== undefined) record.closed = true;
  };

  /**
   * Close a postmark and tell its recipient session to dismiss the message
   * or cancel the turn handling it (`SessionInternal.cancelMail`,
   * sendOnly): a cancelled ask or request (3.1).
   * @param {number} postmark
   */
  const cancelDelivery = postmark => {
    const record = postmarks.get(postmark);
    closePostmark(postmark);
    if (record === undefined || !('row' in record.recipient)) return;
    const { row } = record.recipient;
    if (row.internal === undefined || row.dropped) return;
    E.sendOnly(row.internal).cancelMail(postmark);
  };

  return harden({
    addressFor,
    /** @param {Row} row */
    outboxFor: row => {
      let outbox = outboxOfRow.get(row);
      if (outbox === undefined) {
        outbox = makeExo('Outbox', I.Outbox, {
          /** @param {any} draft */
          post: draft => post({ from: { row }, draft }),
        });
        outboxOfRow.set(row, outbox);
      }
      return outbox;
    },
    operatorAddress: () => operatorAddressObject,
    recipientOf,
    /**
     * Recognise `object` (a SubagentHandle the subagent tree minted) as an
     * address of `row`.
     * @param {object} object
     * @param {Row} row
     */
    bindAddress: (object, row) => {
      parties.set(object, partyOfRow(row));
    },
    post,
    /**
     * Register an open ask: `listener(reply)` once, instead of delivery.
     * @param {number} postmark
     * @param {(reply: Reply) => void} listener
     */
    onReply: (postmark, listener) => {
      const record = postmarks.get(postmark);
      if (record === undefined || record.closed) return false;
      asks.set(postmark, { record, listener });
      return true;
    },
    closePostmark,
    cancelDelivery,
    /**
     * The recipient party of a postmark still in the ring (operator mail's
     * request handles and the subagent tree read it).
     * @param {number} postmark
     */
    recipientOfPostmark: postmark => postmarks.get(postmark)?.recipient,
    copy,
    /** The time a message without a caller's `at` is stamped with. */
    now: () => stampOf(undefined),
    /**
     * The operator's inbox (`operator-mail.js` registers its `deliver`).
     * @param {(envelope: any) => any} deliver
     */
    attachOperatorInbox: deliver => {
      operatorInbox = deliver;
    },
    /** @param {any} envelope */
    deliverOperator: envelope =>
      operatorInbox === undefined
        ? harden({ refused: postOfficeTexts.notAnAddress })
        : operatorInbox(envelope),
    restart,
    rowRemoved,
    /** Bookkeeping sizes (tests, status). */
    status: () =>
      harden({
        inFlight: flights.size,
        keptBytes,
        postmarks: postmarks.size,
        asks: asks.size,
        redriven: counts.redriven,
      }),
  });
};
harden(makePostOffice);

/** @typedef {ReturnType<typeof makePostOffice>} PostOffice */
