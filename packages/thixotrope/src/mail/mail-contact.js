// @ts-check
import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { E } from '@endo/far';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { M } from '@endo/patterns';

/** @import { Mailbox } from './mailbox.js' */

/**
 * A local contact for one correspondent. It carries no pet name or registry.
 * Its inbound facet grants delivery only; its owner controls introductions.
 * Shipped by source, so it can be created in the persistent workspace.
 *
 * Status is `pending` while no introduction has concluded, `ready` once the
 * correspondent's inbox is held, `failed` when the last acceptance was
 * refused (with `error` saying why), and `cancelled` when the owner revoked
 * an unredeemed invitation. A `failed` or `cancelled` contact can be retried
 * with `invite` or `accept`; the last error stays visible until an attempt
 * succeeds.
 *
 * @param {() => Mailbox} provideMailbox the mailbox deliveries land in,
 *   looked up at each delivery so a replaced mailbox is followed
 */
export const makeMailContact = provideMailbox => {
  // Shipped by source: the guards travel with the factory, defined here.
  const CapabilityShape = M.remotable('capability');
  const ContactInboxI = M.interface('ContactInbox', {
    deliver: M.call(M.bigint(), M.string(), CapabilityShape).returns(
      M.promise(),
    ),
  });
  const MailboxInvitationI = M.interface('MailboxInvitation', {
    help: M.call().returns(M.string()),
    accept: M.call(CapabilityShape).returns(M.remotable('inbox')),
  });
  const MailContactI = M.interface('MailContact', {
    help: M.call().returns(M.string()),
    status: M.call().returns(M.record()),
    assertIntroducible: M.call().returns(M.boolean()),
    // The redemption callback stays in this vat and is not passable.
    invite: M.call().optional(M.raw()).returns(M.remotable('invitation')),
    revokeInvitation: M.call().returns(M.boolean()),
    accept: M.call(CapabilityShape).returns(M.boolean()),
    deliver: M.call(M.string(), CapabilityShape).returns(M.promise()),
  });

  /** @type {'pending' | 'ready' | 'failed' | 'cancelled'} */
  let status = 'pending';
  let nextSent = 0n;
  // The correspondent's inbox facet once ready, or the acceptance in flight.
  /** @type {any} */
  let remote;
  /** @type {string | undefined} */
  let error;
  let invitationOpen = false;
  const assertIntroducible = () => {
    (status !== 'ready' && remote === undefined && !invitationOpen) ||
      Fail`Introduction already started`;
  };
  // Remote-controlled text: bound it here as well as at display.
  /** @param {unknown} reason */
  const describeError = reason => String(reason).slice(0, 512);
  // The sender cannot choose the contact recorded in our inbox: this facet
  // binds delivery to the local contact that owns this introduction.
  const receiver = makeExo('ContactInbox', ContactInboxI, {
    /**
     * @param {bigint} sequence
     * @param {string} text
     * @param {any} capability
     */
    deliver: (sequence, text, capability) =>
      E(provideMailbox()).receive(contact, sequence, text, capability),
  });
  const contact = makeExo('MailContact', MailContactI, {
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
      onRedeemed === undefined ||
        typeof onRedeemed === 'function' ||
        Fail`Expected a redemption callback`;
      assertIntroducible();
      invitationOpen = true;
      status = 'pending';
      return makeExo('MailboxInvitation', MailboxInvitationI, {
        help: () => 'accept(counterpart) exchanges inbox capabilities once.',
        /** @param {any} counterpart */
        accept: counterpart => {
          invitationOpen || Fail`Invitation was revoked`;
          remote === undefined ||
            remote === counterpart ||
            Fail`Invitation already redeemed`;
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
      assertIntroducible();
      status = 'pending';
      const attempt = E(invitation)
        .accept(receiver)
        .then(counterpart => {
          passStyleOf(counterpart) === 'remotable' ||
            Fail`Expected a remotable capability`;
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
      status === 'ready' || Fail`Contact is not ready`;
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
