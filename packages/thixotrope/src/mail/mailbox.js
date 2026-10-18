// @ts-check
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { E } from '@endo/far';
import harden from '@endo/harden';
import { M } from '@endo/patterns';

import { describeError } from '../describe-error.js';

/** @import { MailContent } from './types.js' */
/** @import { ObservableMap } from '../observable-map.js' */

/**
 * Guest-owned messages, addressed directly to contact capabilities. This
 * factory is shipped by source, so the supervisor can evaluate it in a
 * separate persistent mailbox vat; it receives the observable-map factory
 * the same way, as source evaluated in that vat.
 *
 * The inbox and outbox are observable maps of immutable message records, so
 * a view can subscribe to either and re-list on change. A delivery outcome
 * replaces the outbox record rather than mutating it, which is what notifies
 * the outbox's subscribers.
 *
 * @param {() => ObservableMap} makeObservableMap
 */
export const makeMailbox = makeObservableMap => {
  // Shipped by source: the guards travel with the factory, defined here.
  const CapabilityShape = M.remotable('capability');
  const NameShape = M.and(M.string({ stringLengthLimit: 128 }), M.not(''));
  const ContentShape = M.arrayOf(
    M.or(
      M.string({ stringLengthLimit: 4096 }),
      M.splitRecord({ name: NameShape, value: M.remotable('capability') }, {}),
    ),
    { arrayLengthLimit: 64 },
  );
  const MailboxI = M.interface('Mailbox', {
    help: M.call().returns(M.string()),
    receive: M.call(CapabilityShape, M.bigint(), ContentShape).returns(
      M.boolean(),
    ),
    send: M.call(CapabilityShape, ContentShape).returns(M.string()),
    inbox: M.call().returns(M.arrayOf(M.record())),
    outbox: M.call().returns(M.arrayOf(M.record())),
    take: M.call(M.string(), M.number())
      .optional(M.or('inbox', 'outbox'))
      .returns(CapabilityShape),
    discard: M.call(M.string()).returns(M.boolean()),
    // Listeners are the observable map's to take, plain or remote.
    subscribeInbox: M.call(M.raw())
      .optional(M.boolean())
      .returns(M.remotable('subscription')),
    subscribeOutbox: M.call(M.raw())
      .optional(M.boolean())
      .returns(M.remotable('subscription')),
    disconnectEphemeral: M.call().returns(M.undefined()),
  });

  typeof makeObservableMap === 'function' ||
    Fail`Expected an observable map factory`;
  const inbox = makeObservableMap();
  const outbox = makeObservableMap();
  let nextReceived = 0n;
  let nextSent = 0n;
  /** @type {Map<any, bigint>} */
  const accepted = new Map();
  /** @param {MailContent} content */
  const describeContent = content =>
    harden(
      content.map(part =>
        typeof part === 'string' ? part : { name: part.name },
      ),
    );
  return makeExo('Mailbox', MailboxI, {
    help: () =>
      'send(contact, content), receive(contact, sequence, content), inbox(), outbox(), take(id, index), discard(id), subscribeInbox(listener, ephemeral?), subscribeOutbox(listener, ephemeral?).',
    /**
     * @param {any} contact
     * @param {bigint} sequence
     * @param {MailContent} content
     */
    receive: (contact, sequence, content) => {
      sequence >= 1n || Fail`Invalid message sequence`;
      if (sequence <= (accepted.get(contact) ?? 0n)) return true;
      nextReceived += 1n;
      inbox.set(String(nextReceived), harden({ from: contact, content }));
      accepted.set(contact, sequence);
      return true;
    },
    /**
     * @param {any} contact
     * @param {MailContent} content
     */
    send: (contact, content) => {
      nextSent += 1n;
      const id = String(nextSent);
      /**
       * @param {string} status
       * @param {string | undefined} error
       */
      const record = (status, error) =>
        outbox.set(
          id,
          harden({
            id,
            to: contact,
            content,
            status,
            error,
          }),
        );
      record('sending', undefined);
      // Exactly one application invocation. The durable node outbox owns
      // delivery retries after admission; a reconnect never invokes send again.
      E(contact)
        .deliver(content)
        .then(
          () => record('delivered', undefined),
          reason => record('failed', describeError(reason)),
        );
      return id;
    },
    inbox: () =>
      harden(
        [...inbox.entries()].map(([id, { from, content }]) => ({
          id,
          from,
          content: describeContent(content),
        })),
      ),
    outbox: () =>
      harden(
        [...outbox.entries()].map(([, message]) => ({
          ...message,
          content: describeContent(message.content),
        })),
      ),
    /**
     * @param {string} id
     * @param {number} index content array position
     * @param {'inbox' | 'outbox'} [box]
     */
    take: (id, index, box = 'inbox') => {
      /** @type {{content: MailContent} | undefined} */
      const message = (box === 'inbox' ? inbox : outbox).get(id);
      if (message === undefined) throw Fail`Unknown message`;
      (Number.isInteger(index) &&
        index >= 0 &&
        index < message.content.length) ||
        Fail`Invalid content index`;
      const part = message.content[index];
      if (typeof part === 'string')
        throw Fail`Content part is text, not a capability`;
      return part.value;
    },
    /** @param {string} id */
    discard: id => inbox.delete(id),
    /**
     * @param {any} listener
     * @param {boolean} [ephemeral]
     */
    subscribeInbox: (listener, ephemeral = false) =>
      inbox.subscribe(listener, ephemeral),
    /**
     * @param {any} listener
     * @param {boolean} [ephemeral]
     */
    subscribeOutbox: (listener, ephemeral = false) =>
      outbox.subscribe(listener, ephemeral),
    // Supervisor restart is a lifetime boundary for all old UI connections.
    disconnectEphemeral: () => {
      inbox.disconnectEphemeral();
      outbox.disconnectEphemeral();
    },
  });
};
harden(makeMailbox);

/**
 * The guest-owned protocol mailbox: direct capability mail with
 * at-most-once receive sequencing and an outbox the durable node
 * outbox delivers. Shipped by source, so it can run in a guest compartment.
 * @typedef {ReturnType<typeof makeMailbox>} Mailbox
 */
