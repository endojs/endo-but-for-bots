// @ts-check
import { Fail } from '@endo/errors';
import { E } from '@endo/far';
import harden from '@endo/harden';

/** @import { MailUiApi } from './mail-ui.js' */

/**
 * Attenuate the address book to descriptions and sends with a fixed grant set.
 * Values are captured at launch; editing the inventory cannot widen this UI.
 * @param {any} book
 * @param {any} contacts
 * @param {string} workspace
 * @param {Map<string, any>} attachments
 * @returns {MailUiApi}
 */
export const makeMailUiService = (book, contacts, workspace, attachments) => {
  const grants = new Map(attachments);
  return harden({
    snapshot: async () => {
      const [listedContacts, inbox, outbox] = await Promise.all([
        E(book).contacts(),
        E(book).inbox(),
        E(book).outbox(),
      ]);
      return harden({
        workspace,
        contacts: listedContacts,
        inbox: await Promise.all(
          inbox.map(async message => ({
            ...message,
            from: (await E(contacts).keyOf(message.from)) ?? '<unnamed>',
          })),
        ),
        outbox: await Promise.all(
          outbox.map(async message => ({
            ...message,
            to: (await E(contacts).keyOf(message.to)) ?? '<unnamed>',
          })),
        ),
        attachments: [...grants.keys()],
      });
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
