// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * Guest-owned contacts, invitations and offers. This factory is self-contained
 * so the supervisor can evaluate it in a separate persistent mailbox vat.
 */
export const makeMailbox = () => {
  /** @type {Map<string, any>} */
  const contacts = new Map();
  /** @type {Map<string, any>} */
  const inbox = new Map();
  /** @type {Map<string, any>} */
  const outbox = new Map();
  let nextReceived = 0n;
  let nextSent = 0n;
  /** @param {unknown} name */
  const assertName = name => {
    if (typeof name !== 'string' || !name.length || name.length > 128)
      throw Error('Expected a contact name of 1–128 characters');
  };
  /** @param {unknown} value */
  const assertCapability = value => {
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      value[Symbol.for('passStyle')] !== 'remotable'
    )
      throw Error('Expected a remotable capability');
  };
  /** @param {string} name */
  const reserve = name => {
    assertName(name);
    if (contacts.has(name)) throw Error('Contact name already reserved');
    /** @type {{name: string, status: string, remote: any, error: string | undefined, invitationOpen?: boolean}} */
    const contact = {
      name,
      status: 'pending',
      remote: undefined,
      error: undefined,
    };
    contacts.set(name, contact);
    return contact;
  };
  /** @param {string} name */
  const makeReceiver = name => {
    let accepted = 0n;
    return Far('ContactInbox', {
      help: () =>
        'deliver(sequence, text, capability) submits an offer to this contact.',
      /** @param {bigint} sequence @param {string} text @param {any} capability */
      deliver: (sequence, text, capability) => {
        if (typeof sequence !== 'bigint' || sequence < 1n)
          throw Error('Invalid message sequence');
        if (sequence <= accepted) return true;
        // Failed admission can consume an outgoing id without delivering it.
        // The node preserves ordering; gaps are valid, repeated ids are not
        // another offer and must not retain another copy of its capability.
        if (typeof text !== 'string' || text.length > 4096)
          throw Error('Message text exceeds 4096 characters');
        assertCapability(capability);
        nextReceived += 1n;
        inbox.set(String(nextReceived), { from: name, text, capability });
        accepted = sequence;
        return true;
      },
    });
  };
  /** @type {Map<string, bigint>} */
  const sequences = new Map();
  return Far('Mailbox', {
    help: () =>
      'invite(name), connect(name, invitation), contacts(), send(name, text, capability), inbox(), outbox(), take(id), discard(id). Names are local labels, not authenticated identities.',
    /** @param {string} name */
    invite: name => {
      const contact = reserve(name);
      contact.invitationOpen = true;
      const receiver = makeReceiver(name);
      return Far('MailboxInvitation', {
        help: () => 'accept(receiver) exchanges inbox capabilities once.',
        accept: remote => {
          if (!contact.invitationOpen) throw Error('Invitation was cancelled');
          assertCapability(remote);
          if (contact.remote !== undefined && contact.remote !== remote)
            throw Error('Invitation already redeemed');
          contact.remote = remote;
          contact.status = 'ready';
          return receiver;
        },
      });
    },
    /** @param {string} name */
    cancelInvitation: name => {
      const contact = contacts.get(name);
      if (!contact || contact.invitationOpen === undefined)
        throw Error('Unknown invitation');
      contact.invitationOpen = false;
      if (contact.status === 'pending') contact.status = 'cancelled';
      return true;
    },
    /** @param {string} name @param {any} invitation */
    connect: (name, invitation) => {
      assertCapability(invitation);
      const contact = reserve(name);
      // This pending answer and its listener belong to this guest, not the
      // ephemeral command that initiates the introduction.
      contact.remote = E(invitation)
        .accept(makeReceiver(name))
        .then(remote => {
          assertCapability(remote);
          contact.status = 'ready';
          return remote;
        })
        .catch(error => {
          contact.status = 'failed';
          contact.error = String(error);
          throw error;
        });
      contact.remote.catch(() => {});
      return true;
    },
    contacts: () =>
      harden(
        [...contacts.values()].map(({ name, status, error }) => ({
          name,
          status,
          error,
        })),
      ),
    /** @param {string} name @param {string} text @param {any} capability */
    send: (name, text, capability) => {
      const contact = contacts.get(name);
      if (!contact || contact.status !== 'ready')
        throw Error('Contact is not ready');
      if (typeof text !== 'string' || text.length > 4096)
        throw Error('Message text exceeds 4096 characters');
      assertCapability(capability);
      const sequence = (sequences.get(name) ?? 0n) + 1n;
      sequences.set(name, sequence);
      nextSent += 1n;
      const id = String(nextSent);
      /** @type {{id: string, to: string, text: string, status: string, error: string | undefined}} */
      const entry = { id, to: name, text, status: 'sending', error: undefined };
      outbox.set(id, entry);
      // Exactly one application invocation. The durable node outbox owns
      // delivery retries after admission; a reconnect never invokes send again.
      E(contact.remote)
        .deliver(sequence, text, capability)
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
