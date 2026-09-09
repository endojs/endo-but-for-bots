// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Guest-owned offers, addressed directly to correspondent capabilities. This factory is self-contained
 * so the supervisor can evaluate it in a separate persistent mailbox vat.
 */
export const makeMailbox = () => {
  /** @type {Map<string, any>} */
  const inbox = new Map();
  /** @type {Map<string, any>} */
  const outbox = new Map();
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
  /** @type {Map<any, bigint>} */
  const accepted = new Map();
  return Far('Mailbox', {
    help: () =>
      'send(identity, text, capability), receive(identity, sequence, text, capability), inbox(), outbox(), take(id), discard(id).',
    receive: (identity, sequence, text, capability) => {
      assertCapability(identity);
      if (typeof sequence !== 'bigint' || sequence < 1n)
        throw Error('Invalid message sequence');
      if (sequence <= (accepted.get(identity) ?? 0n)) return true;
      if (typeof text !== 'string' || text.length > 4096)
        throw Error('Message text exceeds 4096 characters');
      assertCapability(capability);
      nextReceived += 1n;
      inbox.set(String(nextReceived), { from: identity, text, capability });
      accepted.set(identity, sequence);
      return true;
    },
    /**
     * @param {any} identity @param {string} text @param {any} capability
     * @param text
     * @param capability
     */
    send: (identity, text, capability) => {
      assertCapability(identity);
      if (typeof text !== 'string' || text.length > 4096)
        throw Error('Message text exceeds 4096 characters');
      assertCapability(capability);
      nextSent += 1n;
      const id = String(nextSent);
      /** @type {{id: string, to: any, text: string, status: string, error: string | undefined}} */
      const entry = {
        id,
        to: identity,
        text,
        status: 'sending',
        error: undefined,
      };
      outbox.set(id, entry);
      // Exactly one application invocation. The durable node outbox owns
      // delivery retries after admission; a reconnect never invokes send again.
      E(identity)
        .deliver(text, capability)
        .then(
          () => {
            entry.status = 'delivered';
          },
          error => {
            entry.status = 'failed';
            entry.error = String(error);
          },
        );
      return id;
    },
    inbox: () =>
      harden([...inbox].map(([id, { from, text }]) => ({ id, from, text }))),
    outbox: () => harden([...outbox.values()].map(entry => ({ ...entry }))),
    /** @param {string} id */
    take: id => {
      const entry = inbox.get(id);
      if (!entry) throw Error('Unknown offer');
      return entry.capability;
    },
    /** @param {string} id */
    discard: id => inbox.delete(id),
  });
};
harden(makeMailbox);
