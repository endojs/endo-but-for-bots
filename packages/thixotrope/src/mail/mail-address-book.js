// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/** @import { Mailbox } from './mailbox.js' */
/** @import { MailContact } from './mail-contact.js' */
/** @import { ObservableInventory } from '../inventory/observable-inventory.js' */

/**
 * Workspace convenience API. Pet names live in the user's observable inventory
 * entry, never in the mailbox protocol. Users can retain and send to identities
 * directly without registering names here.
 * @param {Mailbox} mailbox
 * @param {ObservableInventory} contacts
 * @param {(mailbox: Mailbox) => MailContact} makeContact
 */
export const makeMailAddressBook = (mailbox, contacts, makeContact) => {
  /** @param {string} name */
  const reserve = name => {
    if (typeof name !== 'string' || !name.length || name.length > 128)
      throw Error('Expected a contact name of 1–128 characters');
    if (contacts.has(name)) throw Error('Contact name already reserved');
    const identity = makeContact(mailbox);
    contacts.set(name, identity);
    return identity;
  };
  /** @param {string} name */
  const inviteWithIdentity = async name => {
    const identity = reserve(name);
    const invitation = await E(identity).invite();
    // Capture ownership before yielding: a pet name may be reassigned while
    // the host awaits publication of the invitation.
    return harden({ identity, invitation });
  };
  /** @param {any} identity */
  const label = identity =>
    [...contacts.entries()].find(([, value]) => value === identity)?.[0] ??
    '<unnamed>';
  return Far('MailAddressBook', {
    help: () =>
      'Workspace pet-name convenience for capability mail; contacts are in inventory.',
    invite: async name => (await inviteWithIdentity(name)).invitation,
    inviteWithIdentity,
    cancelInvitation: name => {
      const identity = contacts.get(name);
      if (!identity) throw Error('Unknown invitation');
      return E(identity).cancelInvitation();
    },
    connect: (name, invitation) => {
      if (!invitation || invitation[Symbol.for('passStyle')] !== 'remotable')
        throw Error('Expected a remotable capability');
      return E(reserve(name)).connect(invitation);
    },
    contacts: () =>
      Promise.all(
        [...contacts.entries()].map(async ([name, identity]) => ({
          name,
          ...(await E(identity).status()),
        })),
      ),
    send: async (name, text, capability) => {
      const identity = contacts.get(name);
      if (!identity || (await E(identity).status()).status !== 'ready')
        throw Error('Contact is not ready');
      return E(mailbox).send(identity, text, capability);
    },
    inbox: async () =>
      (await E(mailbox).inbox()).map(entry => ({
        ...entry,
        from: label(entry.from),
      })),
    outbox: async () =>
      (await E(mailbox).outbox()).map(entry => ({
        ...entry,
        to: label(entry.to),
      })),
    take: id => E(mailbox).take(id),
    discard: id => E(mailbox).discard(id),
  });
};
harden(makeMailAddressBook);
