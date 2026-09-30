// @ts-check
import { Fail, X, makeError, q } from '@endo/errors';
import { Far } from '@endo/far';
import harden from '@endo/harden';

const invitationVersion = 1;
const maxInvitationLength = 4096;
const maxNameLength = 128;
const secretPattern = /^[0-9a-f]{32}$/;

/** @param {unknown} secret */
const assertSecret = secret => {
  if (typeof secret !== 'string' || !secretPattern.test(secret))
    throw Fail`Invalid invitation secret`;
  return secret;
};

/** @param {unknown} name */
const assertName = name => {
  if (typeof name !== 'string' || !name.length || name.length > maxNameLength)
    throw Fail`Expected a contact name of 1–${q(maxNameLength)} characters`;
  return name;
};

/**
 * The host authority behind capability-mail introductions, gathered into one
 * resource so that whoever holds the address book can invite, accept and
 * revoke without holding the daemon: publishing an invitation under a
 * swissnum, withdrawing that publication, and fetching a remote publication
 * through the durable peer session.
 *
 * Invitation text is JSON, `{ version: 1, location, secret, name }`, where
 * `name` is the pet name the inviter chose for the invitee. `redeem` accepts
 * only that shape, and only a location the supplied validator admits, before
 * it records any session intent toward the peer.
 *
 * The daemon restores its recorded resources before its netlayer listens, so
 * the location is read when an invitation is published, not when the
 * resource is made.
 *
 * @param {object} powers
 * @param {(value: object) => string} powers.publish persist a swissnum
 *   locator for a capability the daemon endpoint holds; returns the secret
 * @param {(secret: string) => void} powers.unpublish withdraw a locator;
 *   references already fetched stay valid
 * @param {(location: any, secret: string) => Promise<any>} powers.importReference
 *   fetch a remote publication through the durable peer session
 * @param {() => any} powers.location this daemon's OCapN location
 * @param {(location: unknown) => any} powers.assertLocation validate and
 *   normalise a peer location before anything dials it
 */
export const makeMailIntroductions = ({
  publish,
  unpublish,
  importReference,
  location,
  assertLocation,
}) => {
  /** @param {unknown} text */
  const parseInvitation = text => {
    if (typeof text !== 'string' || text.length > maxInvitationLength)
      throw Fail`Invalid invitation`;
    /** @type {any} */
    let invitation;
    try {
      invitation = JSON.parse(text);
    } catch (error) {
      throw makeError(X`Invalid invitation`, Error, {
        cause: /** @type {Error} */ (error),
      });
    }
    const secret = /** @type {unknown} */ (invitation?.secret);
    const name = /** @type {unknown} */ (invitation?.name);
    if (
      invitation?.version !== invitationVersion ||
      typeof secret !== 'string' ||
      !secretPattern.test(secret) ||
      typeof name !== 'string' ||
      !name.length ||
      name.length > maxNameLength
    )
      throw Fail`Invalid invitation`;
    return harden({
      version: invitationVersion,
      location: assertLocation(invitation.location),
      secret,
      name,
    });
  };
  return Far('MailIntroductions', {
    /** @returns {string} */
    help: () =>
      'Host authority for capability-mail introductions: publish(invitation, name) returns invitation text; unpublish(secret) withdraws a publication; redeem(invitationText) fetches the remote invitation it names.',
    /**
     * @param {object} invitation
     * @param {string} name the pet name the inviter chose for the invitee
     */
    publish: (invitation, name) => {
      assertName(name);
      if (invitation === null || typeof invitation !== 'object')
        throw Fail`Expected an invitation capability`;
      const secret = publish(invitation);
      return JSON.stringify({
        version: invitationVersion,
        location: location(),
        secret,
        name,
      });
    },
    /** @param {string} secret */
    unpublish: secret => {
      unpublish(assertSecret(secret));
      return true;
    },
    /** @param {string} invitationText */
    redeem: invitationText => {
      const invitation = parseInvitation(invitationText);
      return importReference(invitation.location, invitation.secret);
    },
  });
};
harden(makeMailIntroductions);

/**
 * @typedef {ReturnType<typeof makeMailIntroductions>} MailIntroductions
 */
