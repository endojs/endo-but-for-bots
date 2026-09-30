// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/** @import { ObservableMap } from '../observable-map.js' */

/**
 * Guest-owned messages, addressed directly to contact capabilities. This
 * factory is self-contained so the supervisor can evaluate it in a separate
 * persistent mailbox vat; it receives the observable-map factory the same
 * way, as source evaluated in that vat.
 *
 * The inbox and outbox are observable maps of immutable message records, so
 * a view can subscribe to either and re-list on change. A delivery outcome
 * replaces the outbox record rather than mutating it, which is what notifies
 * the outbox's subscribers.
 *
 * @param {() => ObservableMap} makeObservableMap
 */
export const makeMailbox = makeObservableMap => {
  if (typeof makeObservableMap !== 'function')
    throw Error('Expected an observable map factory');
  const inbox = makeObservableMap();
  const outbox = makeObservableMap();
  let nextReceived = 0n;
  let nextSent = 0n;
  /** @param {unknown} value */
  const assertCapability = value => {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      value[Symbol.for('passStyle')] !== 'remotable'
    )
      throw Error('Expected a remotable capability');
  };
  /** @param {unknown} text */
  const assertText = text => {
    if (typeof text !== 'string' || text.length > 4096)
      throw Error('Message text exceeds 4096 characters');
  };
  /** @param {unknown} id */
  const assertId = id => {
    if (typeof id !== 'string') throw Error('Expected a message id');
  };
  // Remote-controlled text: bound it here as well as at display.
  /** @param {unknown} reason */
  const describeError = reason => String(reason).slice(0, 512);
  /** @type {Map<any, bigint>} */
  const accepted = new Map();
  return Far('Mailbox', {
    help: () =>
      'send(contact, text, capability), receive(contact, sequence, text, capability), inbox(), outbox(), take(id), discard(id), subscribeInbox(listener, ephemeral?), subscribeOutbox(listener, ephemeral?).',
    receive: (contact, sequence, text, capability) => {
      assertCapability(contact);
      if (typeof sequence !== 'bigint' || sequence < 1n)
        throw Error('Invalid message sequence');
      if (sequence <= (accepted.get(contact) ?? 0n)) return true;
      assertText(text);
      assertCapability(capability);
      nextReceived += 1n;
      inbox.set(
        String(nextReceived),
        harden({ from: contact, text, capability }),
      );
      accepted.set(contact, sequence);
      return true;
    },
    /**
     * @param {any} contact
     * @param {string} text
     * @param {any} capability
     */
    send: (contact, text, capability) => {
      assertCapability(contact);
      assertText(text);
      assertCapability(capability);
      nextSent += 1n;
      const id = String(nextSent);
      /**
       * @param {string} status
       * @param {string | undefined} error
       */
      const record = (status, error) =>
        outbox.set(id, harden({ id, to: contact, text, status, error }));
      record('sending', undefined);
      // Exactly one application invocation. The durable node outbox owns
      // delivery retries after admission; a reconnect never invokes send again.
      E(contact)
        .deliver(text, capability)
        .then(
          () => record('delivered', undefined),
          reason => record('failed', describeError(reason)),
        );
      return id;
    },
    inbox: () =>
      harden(
        [...inbox.entries()].map(([id, { from, text }]) => ({
          id,
          from,
          text,
        })),
      ),
    outbox: () => harden([...outbox.entries()].map(([, message]) => message)),
    /** @param {string} id */
    take: id => {
      assertId(id);
      const message = inbox.get(id);
      if (!message) throw Error('Unknown message');
      return message.capability;
    },
    /** @param {string} id */
    discard: id => {
      assertId(id);
      return inbox.delete(id);
    },
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
 * outbox delivers. Self-contained so it can run in a guest compartment.
 * @typedef {ReturnType<typeof makeMailbox>} Mailbox
 */
