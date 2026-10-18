// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/far';
import harden from '@endo/harden';

/** @import { MailUiApi } from './mail-ui.js' */

/**
 * Attenuate mail and inventory to descriptions, sends, and explicit adoption.
 * Values are captured at launch; editing the inventory cannot widen this UI.
 * @param {object} options
 * @param {any} options.book
 * @param {any} options.contacts
 * @param {any} options.inventory
 * @param {string} options.workspace
 * @param {Map<string, any>} options.attachments
 * @param {(name: string, value: any) => Promise<string>} options.adoptValue
 * @returns {MailUiApi}
 */
export const makeMailUiService = ({
  book,
  contacts,
  inventory,
  workspace,
  attachments,
  adoptValue,
}) => {
  const grants = new Map(attachments);
  // Tokens designate references in this connection, never inventory names.
  const tokens = new WeakMap();
  let nextToken = 0n;
  /** @type {Map<string, any>} */
  let offered = new Map();
  return harden({
    snapshot: async () => {
      const [listedContacts, inbox, outbox, inventorySnapshot] =
        await Promise.all([
          E(book).contacts(),
          E(book).inbox(),
          E(book).outbox(),
          E(inventory).snapshot(),
        ]);
      /** @type {Map<string, any>} */
      const currentOffers = new Map();
      /** @type {Map<object, Promise<string | undefined>>} */
      const localNames = new Map();
      /** @param {any[]} messages @param {'inbox' | 'outbox'} box */
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
                const value = await E(book).take(message.id, index, box);
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
      const result = harden({
        workspace,
        contacts: listedContacts,
        inbox: await describeMessages(inbox, 'inbox'),
        outbox: await describeMessages(outbox, 'outbox'),
        inventory: inventorySnapshot.entries,
        attachments: [...grants.keys()],
      });
      offered = currentOffers;
      return result;
    },
    adopt: async (token, name) => {
      (typeof token === 'string' && offered.has(token)) ||
        Fail`This value is no longer available; refresh mail`;
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
    send: async (name, text, attachment) => {
      (typeof name === 'string' && name.length > 0 && name.length <= 128) ||
        Fail`Expected a contact name`;
      (typeof text === 'string' &&
        text.trim().length > 0 &&
        text.length <= 4096) ||
        Fail`Expected a message of 1–4096 characters`;
      (typeof attachment === 'string' &&
        (attachment === '' || grants.has(attachment))) ||
        Fail`Capability was not granted to this UI`;
      const contact = await E(contacts).get(name);
      contact !== undefined || Fail`Unknown contact ${name}`;
      const content =
        attachment === ''
          ? [text]
          : [text, { name: attachment, value: grants.get(attachment) }];
      return E(book).send(contact, harden(content));
    },
  });
};
harden(makeMailUiService);
