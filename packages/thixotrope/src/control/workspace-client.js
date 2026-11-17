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
    inbox: () =>
      withBook(async held => {
        const contacts = await client.call('lookup', 'contacts');
        return Promise.all(
          (await E(held).inbox()).map(async message => ({
            ...message,
            from: (await E(contacts).keyOf(message.from)) ?? '<unnamed>',
          })),
        );
      }),
    outbox: () =>
      withBook(async held => {
        const contacts = await client.call('lookup', 'contacts');
        return Promise.all(
          (await E(held).outbox()).map(async message => ({
            ...message,
            to: (await E(contacts).keyOf(message.to)) ?? '<unnamed>',
          })),
        );
      }),
    /**
     * CLI convenience: resolve local labels here, outside the mail protocol.
     * @param {string} name
     * @param {readonly (string | {name: string, key: string})[]} content
     */
    send: async (name, content) => {
      const held = await book();
      const contacts = await client.call('lookup', 'contacts');
      const contact = await client.race(E(contacts).get(name));
      contact !== undefined || Fail`Unknown contact ${name}`;
      const parts = await Promise.all(
        content.map(async part => {
          if (typeof part === 'string') return part;
          assertKey(part.key);
          const capability = await client.call('lookup', part.key);
          return harden({ name: part.name, value: capability });
        }),
      );
      return client.race(E(held).send(contact, harden(parts)));
    },
    /**
     * Keep a message's capability under an inventory key. Taking is
     * idempotent until the message is discarded, so an interrupted take is
     * made again.
     * @param {string} id
     * @param {number} index content array position
     * @param {string} key
     */
    take: async (id, index, key) => {
      assertKey(key);
      const value = await withBook(held => E(held).take(id, index));
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
