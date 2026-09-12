// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * A local identity for one correspondent. It carries no pet name or registry.
 * Its inbound facet grants delivery only; its owner controls introductions.
 * Self-contained so it can be created in the persistent workspace.
 * @param {any} mailbox
 */
export const makeMailContact = mailbox => {
  let status = 'pending';
  let nextSent = 0n;
  /** @type {any} */
  let remote;
  /** @type {string | undefined} */
  let error;
  /** @type {boolean | undefined} */
  let invitationOpen;
  /** @param {any} value */
  const assertCapability = value => {
    if (!value || value[Symbol.for('passStyle')] !== 'remotable')
      throw Error('Expected a remotable capability');
  };
  // The sender cannot choose the identity recorded in our inbox: this facet
  // binds it to the local correspondent that owns this introduction.
  const receiver = Far('ContactInbox', {
    deliver: (sequence, text, capability) =>
      E(mailbox).receive(identity, sequence, text, capability),
  });
  const identity = Far('MailContact', {
    help: () =>
      'A correspondent identity: status(), deliver(), invite(), connect(), cancelInvitation().',
    status: () => harden({ status, error }),
    invite: () => {
      if (invitationOpen || remote !== undefined || status !== 'pending')
        throw Error('Introduction already started');
      invitationOpen = true;
      return Far('MailboxInvitation', {
        help: () => 'accept(receiver) exchanges inbox capabilities once.',
        accept: counterpart => {
          if (!invitationOpen) throw Error('Invitation was cancelled');
          assertCapability(counterpart);
          if (remote !== undefined && remote !== counterpart)
            throw Error('Invitation already redeemed');
          remote = counterpart;
          status = 'ready';
          return receiver;
        },
      });
    },
    cancelInvitation: () => {
      if (invitationOpen === undefined) throw Error('Unknown invitation');
      invitationOpen = false;
      if (status === 'pending') status = 'cancelled';
      return true;
    },
    connect: invitation => {
      assertCapability(invitation);
      if (remote !== undefined || invitationOpen || status !== 'pending')
        throw Error('Introduction already started');
      remote = E(invitation)
        .accept(receiver)
        .then(counterpart => {
          assertCapability(counterpart);
          status = 'ready';
          return counterpart;
        })
        .catch(reason => {
          status = 'failed';
          error = String(reason);
          throw reason;
        });
      remote.catch(() => {});
      return true;
    },
    deliver: (text, capability) => {
      if (status !== 'ready') throw Error('Contact is not ready');
      // Sequence ownership follows the reusable correspondent capability, not
      // any one sending mailbox. Several local mailboxes may share this identity.
      nextSent += 1n;
      return E(remote).deliver(nextSent, text, capability);
    },
  });
  return identity;
};
harden(makeMailContact);
