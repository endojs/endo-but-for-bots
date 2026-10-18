// @ts-check
/* eslint-disable no-await-in-loop -- Serialize projections and subscription setup so no stale snapshot wins or partially acquired observer leaks. */
import { Fail } from '@endo/errors';
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

import { isRemotable } from '../is-remotable.js';
import { makeMailUiSubscription } from './mail-ui-subscription.js';

/** @import { MailUiApi, MailSnapshot } from './mail-ui.js' */

/** @typedef {Omit<MailUiApi, 'subscribe'> & {snapshot: () => Promise<MailSnapshot>, subscribe: (onState: (state: MailSnapshot) => void, onError: (error: Error) => void) => Promise<() => Promise<void>>}} MailUiService */

/**
 * Attenuate mail and inventory to descriptions, sends, and explicit adoption.
 * Inventory selections capture references when a snapshot is requested.
 * @param {object} options
 * @param {any} options.book
 * @param {any} [options.mailbox]
 * @param {any} options.contacts
 * @param {any} options.inventory
 * @param {string} options.workspace
 * @param {Map<string, any>} options.attachments
 * @param {(name: string, value: any) => Promise<string>} options.adoptValue
 * @returns {MailUiService}
 */
export const makeMailUiService = ({
  book,
  mailbox = book,
  contacts,
  inventory,
  workspace,
  attachments,
  adoptValue,
}) => {
  const grants = new Map(attachments);
  /** @type {Map<string, {name: string, value: any}>} */
  const selections = new Map();
  // Tokens designate references in this connection, never inventory names.
  const tokens = new WeakMap();
  let nextToken = 0n;
  /** @type {Map<string, any>} */
  let offered = new Map();
  /** @param {any} value */
  const tokenFor = value => {
    let token = tokens.get(value);
    if (token === undefined) {
      nextToken += 1n;
      token = String(nextToken);
      tokens.set(value, token);
    }
    return token;
  };
  /** @param {Map<string, any>} entries */
  const namesFor = entries =>
    new Map([...entries].map(([name, value]) => [value, name]));
  /**
   * @param {any} state
   * @returns {MailSnapshot}
   */
  const project = state => {
    const localNames = namesFor(state.inventory);
    const contactNames = namesFor(state.contacts);
    const currentOffers = new Map();
    /**
     * @param {Map<string, any>} messages
     * @param {'inbox' | 'outbox'} box
     */
    const describe = (messages, box) =>
      [...messages].map(([id, message]) => ({
        ...message,
        id,
        [box === 'inbox' ? 'from' : 'to']:
          contactNames.get(box === 'inbox' ? message.from : message.to) ??
          '<unnamed>',
        content: message.content.map(part => {
          if (typeof part === 'string') return part;
          const token = tokenFor(part.value);
          currentOffers.set(token, part.value);
          const localName = localNames.get(part.value);
          return {
            name: part.name,
            token,
            ...(localName === undefined ? {} : { localName }),
          };
        }),
      }));
    const available = new Map(grants);
    for (const [name, value] of state.inventory) {
      if (isRemotable(value)) available.set(name, value);
    }
    const attachmentOptions = [...available].map(([name, value]) => {
      const token = tokenFor(value);
      selections.set(token, { name, value });
      return { name, token };
    });
    /** @type {MailSnapshot} */
    const result = harden({
      workspace,
      contacts: [...state.contacts].map(([name, ref]) => ({
        name,
        ...state.statuses.get(ref),
      })),
      inbox: describe(state.inbox, 'inbox'),
      outbox: describe(state.outbox, 'outbox'),
      inventory: [...state.inventory].map(([name, value]) => [
        name,
        typeof value === 'string'
          ? JSON.stringify(value.slice(0, 160))
          : typeof value === 'bigint'
            ? `${value}n`
            : value === null
              ? 'null'
              : typeof value === 'object' || typeof value === 'function'
                ? '<object / capability>'
                : typeof value === 'symbol'
                  ? '<symbol>'
                  : String(value),
      ]),
      attachments: attachmentOptions,
    });
    offered = currentOffers;
    return result;
  };
  /** @type {MailUiService['subscribe']} */
  const legacySubscribe = async (onState, onError) => {
    let active = true;
    let dirty = false;
    let running = false;
    /** @type {any[]} */
    const subscriptions = [];
    /** @type {Map<any, any>} */
    const contactSubscriptions = new Map();
    /** @type {Set<any>} */
    const unsupportedContacts = new Set();
    const close = async () => {
      active = false;
      const handles = [
        ...subscriptions.splice(0),
        ...contactSubscriptions.values(),
      ];
      contactSubscriptions.clear();
      await Promise.allSettled(handles.map(handle => E(handle).unsubscribe()));
    };
    const pump = async () => {
      if (!active || running) return;
      running = true;
      try {
        while (active && dirty) {
          dirty = false;
          const currentContacts = new Set(
            (await E(contacts).entries()).map(([, value]) => value),
          );
          for (const [contact, handle] of contactSubscriptions) {
            if (!currentContacts.has(contact)) {
              contactSubscriptions.delete(contact);
              await E(handle).unsubscribe();
            }
          }
          for (const contact of currentContacts) {
            if (
              contactSubscriptions.has(contact) ||
              unsupportedContacts.has(contact)
            )
              // eslint-disable-next-line no-continue
              continue;
            // eslint-disable-next-line no-underscore-dangle -- Explicit CapTP introspection protocol.
            const methods = await E(contact).__getMethodNames__();
            if (!methods.includes('subscribeStatus')) {
              // Older persisted contacts and constant demo contacts have no
              // status stream. New contacts expose subscribeStatus.
              unsupportedContacts.add(contact);
              // eslint-disable-next-line no-continue
              continue;
            }
            const handle = await E(contact).subscribeStatus(listener);
            if (!active) await E(handle).unsubscribe();
            else contactSubscriptions.set(contact, handle);
          }
          const state = await service.snapshot();
          // A mutation during the reads makes this projection obsolete.
          if (active && !dirty) onState(state);
        }
      } catch (reason) {
        if (active) {
          await close();
          onError(/** @type {Error} */ (reason));
        }
      } finally {
        running = false;
      }
    };
    const invalidate = () => {
      dirty = true;
      void pump();
    };
    const listener = Far('MailUiChanges', { changed: invalidate });
    try {
      for (const opening of [
        () => E(mailbox).subscribeInbox(listener, true),
        () => E(mailbox).subscribeOutbox(listener, true),
        () => E(inventory).subscribe(listener, true),
        () => E(contacts).subscribe(listener, true),
      ]) {
        const handle = await opening();
        if (!active) await E(handle).unsubscribe();
        else subscriptions.push(handle);
      }
      invalidate();
      return harden(close);
    } catch (reason) {
      await close();
      throw reason;
    }
  };
  const subscribe = makeMailUiSubscription({
    mailbox,
    inventory,
    contacts,
    project,
    legacySubscribe,
  });
  /** @type {MailUiService} */
  const service = harden({
    snapshot: async () => {
      const [listedContacts, inbox, outbox, inventorySnapshot] =
        await Promise.all([
          E(book).contacts(),
          E(mailbox).inbox(),
          E(mailbox).outbox(),
          E(inventory).snapshot(),
        ]);
      /** @type {Map<string, any>} */
      const currentOffers = new Map();
      /** @type {Map<object, Promise<string | undefined>>} */
      const localNames = new Map();
      /**
       * @param {any[]} messages
       * @param {'inbox' | 'outbox'} box
       */
      const describeMessages = async (messages, box) =>
        Promise.all(
          messages.map(async message => ({
            ...message,
            [box === 'inbox' ? 'from' : 'to']:
              (await E(contacts).keyOf(
                box === 'inbox' ? message.from : message.to,
              )) ?? '<unnamed>',
            content: await Promise.all(
              message.content.map(async (part, index) => {
                if (typeof part === 'string') return part;
                const value = await E(mailbox).take(message.id, index, box);
                let token = tokens.get(value);
                if (token === undefined) {
                  nextToken += 1n;
                  token = String(nextToken);
                  tokens.set(value, token);
                }
                currentOffers.set(token, value);
                const local =
                  localNames.get(value) ??
                  Promise.resolve(E(inventory).keyOf(value));
                localNames.set(value, local);
                const localName = await local;
                return harden({
                  name: part.name,
                  token,
                  ...(localName === undefined ? {} : { localName }),
                });
              }),
            ),
          })),
        );
      const available = new Map(grants);
      for (const [name, value] of await E(inventory).entries()) {
        if (isRemotable(value)) available.set(name, value);
      }
      const attachmentOptions = [...available].map(([name, value]) => {
        let token = tokens.get(value);
        if (token === undefined) {
          nextToken += 1n;
          token = String(nextToken);
          tokens.set(value, token);
        }
        selections.set(token, { name, value });
        return { name, token };
      });
      const result = harden({
        workspace,
        contacts: listedContacts,
        inbox: await describeMessages(inbox, 'inbox'),
        outbox: await describeMessages(outbox, 'outbox'),
        inventory: inventorySnapshot.entries,
        attachments: attachmentOptions,
      });
      offered = currentOffers;
      return result;
    },
    subscribe: (onState, onError) => subscribe(onState, onError),
    adopt: async (token, name) => {
      (typeof token === 'string' && offered.has(token)) ||
        Fail`This value is no longer available; reconnect mail`;
      (typeof name === 'string' &&
        name.trim().length > 0 &&
        name.length <= 128) ||
        Fail`Choose a local name of 1–128 characters`;
      const value = offered.get(token);
      const known = await E(inventory).keyOf(value);
      if (known !== undefined) return known;
      // The workspace checks and writes in one crank, so another adoption
      // cannot cause an existing inventory name to be silently replaced.
      return adoptValue(name, value);
    },
    send: async (name, parts) => {
      (typeof name === 'string' && name.length > 0 && name.length <= 128) ||
        Fail`Expected a contact name`;
      (Array.isArray(parts) && parts.length > 0 && parts.length <= 256) ||
        Fail`Expected message parts`;
      let length = 0;
      const content = parts.map(part => {
        if (typeof part === 'string') {
          length += part.length;
          return part;
        }
        const selected = part && selections.get(part.token);
        if (!selected) throw Fail`Value was not offered to this UI`;
        return { name: selected.name, value: selected.value };
      });
      length <= 4096 || Fail`Expected at most 4096 text characters`;
      content.some(part => typeof part !== 'string' || part.trim()) ||
        Fail`Expected a nonempty message`;
      const contact = await E(contacts).get(name);
      contact !== undefined || Fail`Unknown contact ${name}`;
      return E(book).send(contact, harden(content));
    },
  });
  return service;
};
harden(makeMailUiService);
