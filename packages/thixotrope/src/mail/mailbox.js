// @ts-check
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { E } from '@endo/far';
import harden from '@endo/harden';
import { M } from '@endo/patterns';

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
  const TextShape = M.string({ stringLengthLimit: 4096 });
  const MailboxI = M.interface('Mailbox', {
    help: M.call().returns(M.string()),
    receive: M.call(
      CapabilityShape,
      M.bigint(),
      TextShape,
      CapabilityShape,
    ).returns(M.boolean()),
    send: M.call(CapabilityShape, TextShape, CapabilityShape).returns(
      M.string(),
    ),
    inbox: M.call().returns(M.arrayOf(M.record())),
    outbox: M.call().returns(M.arrayOf(M.record())),
    take: M.call(M.string()).returns(CapabilityShape),
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
  // Remote-controlled text: bound it here as well as at display.
  /** @param {unknown} reason */
  const describeError = reason => String(reason).slice(0, 512);
  /** @type {Map<any, bigint>} */
  const accepted = new Map();
  return makeExo('Mailbox', MailboxI, {
    help: () =>
      'send(contact, text, capability), receive(contact, sequence, text, capability), inbox(), outbox(), take(id), discard(id), subscribeInbox(listener, ephemeral?), subscribeOutbox(listener, ephemeral?).',
    /**
     * @param {any} contact
     * @param {bigint} sequence
     * @param {string} text
     * @param {any} capability
     */
    receive: (contact, sequence, text, capability) => {
      sequence >= 1n || Fail`Invalid message sequence`;
      if (sequence <= (accepted.get(contact) ?? 0n)) return true;
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
      const message = inbox.get(id);
      message !== undefined || Fail`Unknown message`;
      return message.capability;
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
