// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/** @import { Mailbox } from './mailbox.js' */
/** @import { MailContact } from './mail-contact.js' */
/** @import { MailIntroductions } from './introductions.js' */
/** @import { ObservableMap } from '../observable-map.js' */

/**
 * Workspace convenience API. Pet names live in the user's observable inventory
 * entry, never in the mailbox protocol. Users can retain and send to contacts
 * directly without registering names here.
 *
 * The host authority an introduction needs — publishing an invitation,
 * withdrawing it, fetching a remote one — arrives as the `introductions`
 * resource, so anyone granted this address book can invite and accept.
 *
 * An invitation may be redeemed once. The counterpart keeps the reference it
 * fetched, so re-accepting from the same counterpart stays idempotent, but
 * the publication is withdrawn as soon as the exchange completes and a
 * different counterpart is refused.
 *
 * A pet name whose introduction failed or was revoked keeps its contact, and
 * `invite` or `accept` with that name retries on the same contact.
 *
 * The mailbox is looked up at each use rather than captured: it is an
 * installation the supervisor provides, and one provided afresh after a
 * removal must be the one this book and its contacts speak to.
 *
 * @param {() => Mailbox} provideMailbox
 * @param {ObservableMap} contacts
 * @param {(provideMailbox: () => Mailbox) => MailContact} makeContact
 * @param {MailIntroductions} introductions
 */
export const makeMailAddressBook = (
  provideMailbox,
  contacts,
  makeContact,
  introductions,
) => {
  // Secret → the contact whose invitation is published under it. Ownership
  // follows the contact, not its pet name, which the user may reassign.
  /** @type {Map<string, any>} */
  const invitations = new Map();
  /** @param {unknown} name */
  const assertName = name => {
    if (typeof name !== 'string' || !name.length || name.length > 128)
      throw Error('Expected a contact name of 1–128 characters');
  };
  /**
   * Only the secret is read here; the host validates the rest when the
   * invitation is redeemed.
   * @param {unknown} text
   */
  const secretOf = text => {
    if (typeof text !== 'string' || text.length > 4096)
      throw Error('Invalid invitation');
    /** @type {any} */
    let invitation;
    try {
      invitation = JSON.parse(text);
    } catch (error) {
      throw Error('Invalid invitation', { cause: error });
    }
    const secret = invitation?.secret;
    if (typeof secret !== 'string' || !/^[0-9a-f]{32}$/.test(secret))
      throw Error('Invalid invitation');
    return secret;
  };
  /** @param {string} name */
  const provideContact = name => {
    assertName(name);
    let contact = contacts.get(name);
    if (contact === undefined) {
      contact = makeContact(provideMailbox);
      contacts.set(name, contact);
    }
    return contact;
  };
  /** @param {any} contact */
  const label = contact => contacts.keyOf(contact) ?? '<unnamed>';
  /** @param {string} secret */
  const forget = secret => {
    invitations.delete(secret);
    // The counterpart already holds the invitation; withdrawing its locator
    // only stops further fetches. A withdrawal the host could not perform
    // is retried by `revokeInvitation`, which always unpublishes.
    void E(introductions)
      .unpublish(secret)
      .catch(() => {});
  };
  return Far('MailAddressBook', {
    help: () =>
      'Capability mail by pet name: invite(name), accept(name, invitationText), revokeInvitation(invitationText), contacts(), send(name, text, capability), inbox(), outbox(), take(id), discard(id). Contacts are the inventory contacts map.',
    /**
     * Reserve the name, open an invitation on its contact and publish it.
     * Returns the invitation text to hand to the correspondent.
     * @param {string} name
     */
    invite: async name => {
      // Capture ownership before yielding: a pet name may be reassigned
      // while the host publishes the invitation.
      const contact = provideContact(name);
      /** @type {string | undefined} */
      let secret;
      const invitation = await E(contact).invite(() => {
        if (secret !== undefined) forget(secret);
      });
      try {
        const text = await E(introductions).publish(invitation, name);
        secret = secretOf(text);
        invitations.set(secret, contact);
        return text;
      } catch (error) {
        // Nothing can redeem an unpublished invitation; close it so the
        // name can be retried.
        await E(contact).revokeInvitation();
        throw error;
      }
    },
    /**
     * Redeem a correspondent's invitation under a pet name. The host
     * validates the text before it records any session intent, so an
     * invalid invitation reserves nothing.
     * @param {string} name
     * @param {string} invitationText
     */
    accept: async (name, invitationText) => {
      assertName(name);
      // Refuse a name already introduced before dialing: redeeming records a
      // durable session intent on the host. The name is reserved only once
      // the host has accepted the text, so an invalid invitation reserves
      // nothing.
      const existing = contacts.get(name);
      if (existing !== undefined) await E(existing).assertIntroducible();
      const invitation = await E(introductions).redeem(invitationText);
      return E(provideContact(name)).accept(invitation);
    },
    /**
     * Withdraw an invitation this address book published. Returns whether
     * an invitation that could still be redeemed was closed; an invitation
     * already redeemed or revoked is a no-op. An established contact stays
     * ready.
     * @param {string} invitationText
     */
    revokeInvitation: async invitationText => {
      const secret = secretOf(invitationText);
      const contact = invitations.get(secret);
      invitations.delete(secret);
      const revoked =
        contact !== undefined && (await E(contact).revokeInvitation());
      await E(introductions).unpublish(secret);
      return revoked;
    },
    contacts: () =>
      Promise.all(
        [...contacts.entries()].map(async ([name, contact]) => ({
          name,
          ...(await E(contact).status()),
        })),
      ),
    send: async (name, text, capability) => {
      const contact = contacts.get(name);
      if (!contact || (await E(contact).status()).status !== 'ready')
        throw Error('Contact is not ready');
      return E(provideMailbox()).send(contact, text, capability);
    },
    inbox: async () =>
      (await E(provideMailbox()).inbox()).map(message => ({
        ...message,
        from: label(message.from),
      })),
    outbox: async () =>
      (await E(provideMailbox()).outbox()).map(message => ({
        ...message,
        to: label(message.to),
      })),
    take: id => E(provideMailbox()).take(id),
    discard: id => E(provideMailbox()).discard(id),
  });
};
harden(makeMailAddressBook);
