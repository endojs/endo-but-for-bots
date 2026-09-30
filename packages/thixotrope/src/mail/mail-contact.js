// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/** @import { Mailbox } from './mailbox.js' */

/**
 * A local contact for one correspondent. It carries no pet name or registry.
 * Its inbound facet grants delivery only; its owner controls introductions.
 * Self-contained so it can be created in the persistent workspace.
 *
 * Status is `pending` while no introduction has concluded, `ready` once the
 * correspondent's inbox is held, `failed` when the last acceptance was
 * refused (with `error` saying why), and `cancelled` when the owner revoked
 * an unredeemed invitation. A `failed` or `cancelled` contact can be retried
 * with `invite` or `accept`; the last error stays visible until an attempt
 * succeeds.
 *
 * @param {Mailbox} mailbox
 */
export const makeMailContact = mailbox => {
  /** @type {'pending' | 'ready' | 'failed' | 'cancelled'} */
  let status = 'pending';
  let nextSent = 0n;
  // The correspondent's inbox facet once ready, or the acceptance in flight.
  /** @type {any} */
  let remote;
  /** @type {string | undefined} */
  let error;
  let invitationOpen = false;
  /** @param {any} value */
  const assertCapability = value => {
    if (!value || value[Symbol.for('passStyle')] !== 'remotable')
      throw Error('Expected a remotable capability');
  };
  const assertIntroducible = () => {
    if (status === 'ready' || remote !== undefined || invitationOpen)
      throw Error('Introduction already started');
  };
  // Remote-controlled text: bound it here as well as at display.
  /** @param {unknown} reason */
  const describeError = reason => String(reason).slice(0, 512);
  // The sender cannot choose the contact recorded in our inbox: this facet
  // binds delivery to the local contact that owns this introduction.
  const receiver = Far('ContactInbox', {
    deliver: (sequence, text, capability) =>
      E(mailbox).receive(contact, sequence, text, capability),
  });
  const contact = Far('MailContact', {
    help: () =>
      'A local contact for one correspondent: status(), invite(onRedeemed?), accept(invitation), revokeInvitation(), deliver(text, capability).',
    status: () => harden({ status, error }),
    /**
     * Refuse now if an introduction is already open or complete, so a caller
     * can check before it does anything with a cost, such as dialing.
     */
    assertIntroducible: () => {
      assertIntroducible();
      return true;
    },
    /**
     * Open an invitation for a correspondent to redeem. The optional
     * callback runs once, when the exchange completes, so the owner can
     * withdraw the invitation's publication.
     * @param {(() => void) | undefined} [onRedeemed]
     */
    invite: (onRedeemed = undefined) => {
      if (onRedeemed !== undefined && typeof onRedeemed !== 'function')
        throw Error('Expected a redemption callback');
      assertIntroducible();
      invitationOpen = true;
      status = 'pending';
      return Far('MailboxInvitation', {
        help: () => 'accept(counterpart) exchanges inbox capabilities once.',
        accept: counterpart => {
          if (!invitationOpen) throw Error('Invitation was revoked');
          assertCapability(counterpart);
          if (remote !== undefined && remote !== counterpart)
            throw Error('Invitation already redeemed');
          const first = remote === undefined;
          remote = counterpart;
          status = 'ready';
          error = undefined;
          if (first && onRedeemed !== undefined) onRedeemed();
          return receiver;
        },
      });
    },
    /**
     * Close the open invitation so nobody can redeem it. An established
     * contact stays ready; an unredeemed one becomes cancelled and can be
     * retried. Returns whether an invitation was open.
     */
    revokeInvitation: () => {
      if (!invitationOpen) return false;
      invitationOpen = false;
      if (status === 'pending') status = 'cancelled';
      return true;
    },
    /**
     * Redeem a correspondent's invitation. The outcome arrives later in
     * `status()`; a refusal leaves the contact retryable.
     * @param {any} invitation
     */
    accept: invitation => {
      assertCapability(invitation);
      assertIntroducible();
      status = 'pending';
      const attempt = E(invitation)
        .accept(receiver)
        .then(counterpart => {
          assertCapability(counterpart);
          return counterpart;
        })
        .then(
          counterpart => {
            if (remote !== attempt) return;
            remote = counterpart;
            status = 'ready';
            error = undefined;
          },
          reason => {
            if (remote !== attempt) return;
            remote = undefined;
            status = 'failed';
            error = describeError(reason);
          },
        );
      remote = attempt;
      return true;
    },
    deliver: (text, capability) => {
      if (status !== 'ready') throw Error('Contact is not ready');
      // Sequence ownership follows the reusable contact, not any one sending
      // mailbox. Several local mailboxes may share this contact.
      nextSent += 1n;
      return E(remote).deliver(nextSent, text, capability);
    },
  });
  return contact;
};
harden(makeMailContact);

/**
 * A local contact for one correspondent: the delivery facet shared by every
 * mailbox that speaks for it, plus the owner's introduction controls.
 * @typedef {ReturnType<typeof makeMailContact>} MailContact
 */
