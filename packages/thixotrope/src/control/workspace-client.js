// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/far';
import harden from '@endo/harden';

/** @import { connectLocalControl } from './local-control.js' */

/**
 * What the operator does with a workspace's mail and its clock, composed in
 * the client from what the administration hands out: the selected
 * workspace's address book, the remotable capability under an inventory
 * key, and keeping a value under one. The administration keeps no method
 * for mail or alarms; the book and the clock are spoken to as any holder
 * of them would, and the inventory supplies what a message carries and
 * receives what a message brought. Every call is raced against the
 * connection, so a disconnect reports that the outcome is unknown.
 *
 * @param {Awaited<ReturnType<typeof connectLocalControl>>} client
 */
export const makeWorkspaceClient = client => {
  /** @returns {Promise<any>} */
  const book = () => client.call('getAddressBook');
  /**
   * @param {unknown} key
   * @returns {asserts key is string}
   */
  const assertKey = key => {
    (typeof key === 'string' && key.length > 0) || Fail`Expected inventory key`;
  };
  /**
   * @template T
   * @param {(book: any) => Promise<T>} use
   */
  const withBook = async use => client.race(use(await book()));
  return harden({
    /** @param {string} name */
    invite: name => withBook(held => E(held).invite(name)),
    /**
     * @param {string} name
     * @param {string} invitationText
     */
    accept: (name, invitationText) =>
      withBook(held => E(held).accept(name, invitationText)),
    /** @param {string} invitationText */
    revokeInvitation: invitationText =>
      withBook(held => E(held).revokeInvitation(invitationText)),
    contacts: () => withBook(held => E(held).contacts()),
    inbox: () => withBook(held => E(held).inbox()),
    outbox: () => withBook(held => E(held).outbox()),
    /**
     * Send the capability kept under an inventory key: only that value
     * crosses into the message, and only a remotable one leaves the
     * workspace.
     * @param {string} name
     * @param {string} text
     * @param {string} key
     */
    send: async (name, text, key) => {
      assertKey(key);
      const capability = await client.call('lookup', key);
      return withBook(held => E(held).send(name, text, capability));
    },
    /**
     * Keep a message's capability under an inventory key. Taking is
     * idempotent until the message is discarded, so an interrupted take is
     * made again.
     * @param {string} id
     * @param {string} key
     */
    take: async (id, key) => {
      assertKey(key);
      const value = await withBook(held => E(held).take(id));
      return client.call('keep', key, value);
    },
    /** @param {string} id */
    discard: id => withBook(held => E(held).discard(id)),
    /**
     * The clock's counts of pending alarms and of armed ones.
     */
    alarms: async () => {
      const clock = await client.call('lookup', 'clock');
      if (clock === undefined) throw Error('The clock is not installed');
      const { pending, armed } = await client.race(E(clock).status());
      return harden({ pending: Number(pending), armed: Number(armed) });
    },
  });
};
harden(makeWorkspaceClient);
