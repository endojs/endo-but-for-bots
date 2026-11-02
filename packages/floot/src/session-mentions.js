// @ts-check
import { E } from '@endo/eventual-send';

/** @typedef {{strings: string[], names: string[]}} ChatMessage */
/** @typedef {{path: string[], identity: string, value: any}} SessionMention */

/**
 * Validate the same text/edge representation used by Endo package messages.
 * @param {ChatMessage} message
 */
export const validateChatMessage = message => {
  if (
    !message ||
    !Array.isArray(message.strings) ||
    !Array.isArray(message.names) ||
    message.names.length > 32 ||
    message.strings.length !== message.names.length + 1 ||
    message.strings.some(s => typeof s !== 'string') ||
    message.names.some(
      n =>
        typeof n !== 'string' ||
        !n ||
        n.length > 255 ||
        n.includes('/') ||
        n.includes('@') ||
        [...n].some(char => char.charCodeAt(0) < 32) ||
        n === '.' ||
        n === '..',
    ) ||
    new Set(message.names).size !== message.names.length ||
    JSON.stringify(message).length > 64_000
  )
    throw Error(
      'Invalid chat message: use at most 32 distinct attachment labels and 64 KB of text',
    );
  return harden({ strings: [...message.strings], names: [...message.names] });
};
harden(validateChatMessage);

/** @param {ChatMessage} message */
export const chatMessageText = message =>
  message.strings
    .map(
      (part, i) =>
        `${part}${i < message.names.length ? `@${message.names[i]}` : ''}`,
    )
    .join('')
    .trim();
harden(chatMessageText);

/** @param {SessionMention[]} mentions */
export const validateMentions = mentions => {
  if (!Array.isArray(mentions) || mentions.length > 32)
    throw Error('A message may mention at most 32 inventory objects');
  for (const mention of mentions) {
    if (
      !mention ||
      !Array.isArray(mention.path) ||
      !mention.path.length ||
      mention.path.length > 32 ||
      mention.path.some(
        part => typeof part !== 'string' || !part || part.length > 256,
      ) ||
      typeof mention.identity !== 'string' ||
      !mention.identity ||
      mention.identity.length > 2048 ||
      !Object.hasOwn(mention, 'value')
    )
      throw Error('Invalid inventory mention');
  }
  return harden(
    mentions.map(({ path, identity, value }) => ({ path, identity, value })),
  );
};
harden(validateMentions);

/**
 * Resolve selected chips; plain text and voice transcripts carry no references.
 * @param {any} powers
 * @param {string[]} petNames
 */
export const resolveMentions = (powers, petNames) =>
  Promise.all(
    petNames.map(async name => {
      const path = name.split('/');
      const identity = await E(powers).identify(...path);
      if (!identity) throw Error(`Inventory object no longer exists: ${name}`);
      const value = await E(powers).lookup(path);
      if ((await E(powers).identify(...path)) !== identity)
        throw Error(`Inventory object changed while sending: ${name}`);
      return harden({ path, identity, value });
    }),
  );
harden(resolveMentions);
