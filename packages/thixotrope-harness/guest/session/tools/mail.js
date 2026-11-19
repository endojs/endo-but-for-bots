// @ts-check
/**
 * The mail tools (designs/m9-interfaces.md 3.2, 4.1, D-M9-14, D-M9-17,
 * D-M9-23; R3-33, R3-214, R3-218): `listMessages`, `send`, `reply`,
 * `dismiss`, static entries of the tool table offered while the session
 * holds its `Outbox` (`services.mail`). The inbox is the `inbox` runtime
 * part (`context.runtime.inbox`); a subagent is named `subagents/<name>`
 * and found in the `subagents` part, never in the label map (both through
 * `tools/subagents.js` `heldObject`, D-M9-23); the recipient `user` is
 * `services.operatorAddress` (`makeLabels` refuses to bind the reserved
 * label `user`).
 *
 * - `listMessages`, `dismiss`: `site: 'session'`, settled in the issuing
 *   crank. `listMessages` renders the inbox part's `views` with
 *   `mail-text.js` `listingText`.
 * - `send`, `reply`: `site: 'guest'`: one answered `Outbox.post` (a factory
 *   exo). Every refusal a session can see is made before it: argument
 *   shape, recipients, attachments by label, the body's size. The post
 *   office's refusals come back per recipient in the receipt and are
 *   forwarded as they are; the result fails only when every recipient
 *   refused.
 *
 * Staged arguments (over `inlineBytes`): the session cannot parse them
 * (rule 12.10), so its exec vat splits them (`splitArgs`, D-M9-14): the
 * residual JSON comes back inline with each long string replaced by a
 * placeholder (`"\u0000s<k>"`) and the strings staged. Arguments over
 * `mailBodyUnits` bytes are refused before the split. A staged string may
 * be the whole body only (with empty strings beside it): composing it with
 * other text would copy its bytes through this vat; it is never a label.
 *
 * `recipient`, `strings`, `edgeNames` and `petNames` are a JSON string or
 * an array of at most `mailParts` strings, read from the raw span the
 * closed parser checked (`readStrings`). Edge and pet names pair by
 * position; a missing one is the other. The body is the strings with
 * `@edge` after each (R4-58).
 *
 * Guest rules: model JSON never becomes a record; no `JSON.parse`.
 */
import { failed, ok } from './outcomes.js';
export { failed, ok } from './outcomes.js';
import {
  textOf,
  textOf as mailTextOf,
  texts as mailTexts,
  mailToolArgumentNames,
} from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { parseClosedArgs } from '../../lib/tool-args.js';
import { messageOf } from '../../lib/bounded.js';
import { listingText } from '../../lib/mail-text.js';
import { fieldBytes, isStaged } from '../staging.js';
import { readArgs } from './objects.js';
import { inspectFor } from './inspect-client.js';
import { heldObject } from './subagents.js';

/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { ArgSpec } from '../../lib/tool-args.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** @param {string} text */
const refused = text => ({ outcome: failed(text) });

/**
 * A closed spec over `mailToolArgumentNames[tool]`, kinds in name order
 * (`raw` when absent); the first `required` names are required.
 * @param {string} tool
 * @param {number} required
 * @param {any[]} [kinds]
 * @returns {ArgSpec}
 */
export const mailSpec = (tool, required, kinds = []) =>
  harden({
    tool,
    fields: /** @type {string[]} */ (mailToolArgumentNames[tool]).map(
      (name, i) => ({ name, kind: kinds[i] ?? 'raw', required: i < required }),
    ),
  });

const specs = harden({
  listMessages: mailSpec('listMessages', 0),
  send: mailSpec('send', 2),
  reply: mailSpec('reply', 2, ['integer']),
  dismiss: mailSpec('dismiss', 1, ['integer']),
});
const ONE = mailSpec('stopSubagent', 1, ['string']);

/**
 * A raw span read as a list of strings (module comment), placeholders
 * answered by their staged strings; `{ list }` or `{ outcome }`.
 * @param {string | undefined} span
 * @param {string} name
 * @param {readonly any[]} staged
 * @param {boolean} [labels] the strings are labels: a staged one is refused
 * @returns {{ list: any[] } | { outcome: any }}
 */
const readStrings = (span, name, staged, labels = false) => {
  const list = [];
  if (span === undefined) return { list };
  let i = span[0] === '[' ? 1 : 0;
  for (;;) {
    while (' \t\r\n,'.includes(span[i])) i += 1;
    if (span[i] === ']' || (i > 0 && i === span.length)) return { list };
    if (span[i] !== '"' || list.length === limits.mailParts) {
      return refused(
        textOf.argumentsNotJson(
          `argument "${name}" must be a string or an array of at most ${limits.mailParts} strings`,
        ),
      );
    }
    const start = i;
    i += 1;
    while (span[i] !== '"') i += span[i] === '\\' ? 2 : 1;
    i += 1;
    /** @type {any} */
    let value = /** @type {any} */ (
      parseClosedArgs(`{"name":${span.slice(start, i)}}`, ONE)
    ).values.get('name');
    if (value.startsWith('\u0000s') && staged.length > 0) {
      value = staged[Number(value.slice(2))];
      if (value === undefined || labels) {
        return refused(
          textOf.argumentsTooLarge(name, value?.bytes, limits.inlineBytes),
        );
      }
    }
    list.push(value);
  }
};

/**
 * The draft's body and attachments from the parsed arguments.
 * @param {any} context
 * @param {Map<string, any>} values
 * @param {readonly any[]} staged
 * @returns {{ outcome: any } | { body: any, attachments: any[] }}
 */
const draftOf = (context, values, staged) => {
  const read = ['strings', 'edgeNames', 'petNames'].map(name =>
    readStrings(values.get(name), name, staged, name !== 'strings'),
  );
  for (const r of read) if ('outcome' in r) return r;
  const [strings, edges, pets] = read.map(
    r => /** @type {any[]} */ (/** @type {any} */ (r).list),
  );
  const n = Math.max(edges.length, pets.length);
  if (n > limits.maxAttachments) return refused(textOf.tooManyAttachments(n));
  const attachments = [];
  const parts = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < Math.max(n, strings.length); i += 1) {
    if (i < strings.length) parts.push(strings[i]);
    if (i < n) {
      const label = edges[i] ?? pets[i];
      const pet = pets[i] ?? label;
      if (seen.has(label)) return refused(textOf.duplicateAttachment(label));
      seen.add(label);
      const found = heldObject(context, pet);
      if ('refused' in found) return refused(found.refused);
      attachments.push(harden({ label, value: found.value }));
      parts.push(`@${label}`);
    }
  }
  const big = strings.filter(isStaged);
  if (big.length === 1 && strings.every(s => s === '' || isStaged(s))) {
    return { body: big[0], attachments };
  }
  let bytes = 0;
  for (const part of parts) bytes += /** @type {number} */ (fieldBytes(part));
  if (big.length > 0 || bytes > limits.inlineBytes) {
    return refused(mailTextOf.bodyTooLong(bytes, limits.inlineBytes));
  }
  return { body: parts.join(''), attachments };
};

/**
 * The closed arguments and draft of `send` or `reply`, split by the exec
 * vat first when staged; `{ values, staged }` or `{ outcome }`.
 * @param {string} tool
 * @param {{ opId: string, args: any }} request
 * @param {any} ports
 * @param {any} context
 */
const readMailArgs = async (tool, { opId, args }, ports, context) => {
  const bytes = /** @type {number} */ (fieldBytes(args));
  const most = limits.mailBodyUnits;
  if (!isStaged(args) || bytes > most) {
    if (bytes > most) return refused(mailTextOf.bodyTooLong(bytes, most));
    const read = readArgs(tool, args, specs[tool]);
    return 'outcome' in read ? read : { values: read.values, staged: [] };
  }
  if (context.services?.execVat === undefined || ports?.writers === undefined) {
    return refused(textOf.argumentsTooLarge(tool, bytes, limits.inlineBytes));
  }
  const outcome = await inspectFor(context)(
    harden({
      op: 'splitArgs',
      // `splitArgs` calls no target; the writers stand in for one.
      target: ports.writers,
      writers: ports.writers,
      args,
      content: ports.content,
      opId,
    }),
  );
  if (outcome?.status !== 'split') return { outcome };
  const parsed = parseClosedArgs(outcome.split.json, specs[tool]);
  if (!parsed.ok) return refused(parsed.text);
  return { values: parsed.values, staged: outcome.split.staged };
};

/**
 * Post `to` with the arguments' draft and render the receipt: one line per
 * recipient, the sent text or the post office's refusal.
 * @param {any} context
 * @param {{ values: Map<string, any>, staged: any[] }} read
 * @param {any[]} to
 * @param {any} more `inReplyTo`
 * @param {(i: number) => string} sentText
 */
const post = async (context, { values, staged }, to, more, sentText) => {
  const draft = draftOf(context, values, staged);
  if ('outcome' in draft) return draft.outcome;
  await null;
  try {
    const { results } = await E(context.services.mail).post(
      harden({ to, ...draft, ...more }),
    );
    const lines = results.map(
      (/** @type {any} */ r, /** @type {number} */ i) =>
        r.refused ?? sentText(i),
    );
    const all = results.every((/** @type {any} */ r) => r.refused);
    return (all ? failed : ok)(lines.join('\n'));
  } catch (error) {
    return failed(messageOf(error));
  }
};

/**
 * The inbox message a tool names, or a failed outcome; an imported message
 * is refused unless `imported` allows it (D-M9-21).
 * @param {any} context
 * @param {number} number
 * @param {boolean} [imported]
 * @returns {{ outcome: any } | { message: any }}
 */
export const inboxMessageOf = (context, number, imported = false) => {
  const message = context.runtime.inbox?.get(number);
  if (message === undefined) return refused(mailTexts.noSuchMessage);
  if (message.imported && !imported) return refused(mailTexts.imported);
  return { message };
};
harden(inboxMessageOf);

/**
 * @param {any} _ports
 * @param {any} services
 */
export const mailAvailable = (_ports, services) => services?.mail !== undefined;

/**
 * A tool's parameter schema, JSON text.
 * @param {string} properties the properties, JSON text without braces
 * @param {string} required JSON text of the required names
 */
export const params = (properties, required) =>
  `{"type":"object","properties":{${properties}},"required":${required}}`;

/** @param {string} about */
const strs = about =>
  `{"type":"array","items":{"type":"string"},"description":"${about}"}`;
const parts = `"strings":${strs('Text parts of the message.')},"edgeNames":${strs(
  'Labels of attached capabilities, as the recipient sees them.',
)},"petNames":${strs('Your petnames of the capabilities to attach.')}`;
const numberParam = '"messageNumber":{"type":"integer"}';

/**
 * After Fae `src/tool-makers.js` (1315bef86); the raw mailbox lifecycle
 * paragraph is dropped (no Endo promises here).
 */
const descriptions = harden({
  listMessages: harden({
    name: 'listMessages',
    description:
      'List messages in your inbox, newest first: number, from, type, text, edge names, state.',
    parameters: params('', '[]'),
  }),
  send: harden({
    name: 'send',
    description:
      'Send a message to another agent or to the user. Strings are text content; edgeNames attach capabilities you hold under petNames.',
    parameters: params(
      `"recipient":{"anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}],"description":"user, a petname, subagents/<name>, or a list of them"},${parts}`,
      '["recipient","strings"]',
    ),
  }),
  reply: harden({
    name: 'reply',
    description: 'Reply to a message by number; the reply goes to its sender.',
    parameters: params(
      `${numberParam},${parts}`,
      '["messageNumber","strings"]',
    ),
  }),
  dismiss: harden({
    name: 'dismiss',
    description: 'Dismiss a handled message from your inbox by number.',
    parameters: params(numberParam, '["messageNumber"]'),
  }),
});

/** @type {ToolTableEntry} */
const listMessagesEntry = harden({
  name: 'listMessages',
  site: 'session',
  describe: () => descriptions.listMessages,
  available: mailAvailable,
  execute: async ({ args }, _ports, context) => {
    const read = readArgs('listMessages', args, specs.listMessages);
    if ('outcome' in read) return read.outcome;
    return ok(
      listingText(
        context.runtime.inbox.views({ limit: limits.listMessagesPage }),
      ),
    );
  },
});

/** @type {ToolTableEntry} */
const sendEntry = harden({
  name: 'send',
  site: 'guest',
  describe: () => descriptions.send,
  available: mailAvailable,
  execute: async (request, ports, context) => {
    const read = await readMailArgs('send', request, ports, context);
    if ('outcome' in read) return read.outcome;
    const to = readStrings(
      read.values.get('recipient'),
      'recipient',
      read.staged,
      true,
    );
    if ('outcome' in to) return to.outcome;
    const labels = to.list;
    if (labels.length === 0 || labels.length > limits.recipientsPerSend) {
      return failed(
        mailTextOf.tooManyRecipients(labels.length, limits.recipientsPerSend),
      );
    }
    const recipients = [];
    for (const label of labels) {
      const { value } = /** @type {any} */ (
        label === 'user'
          ? { value: context.services?.operatorAddress }
          : heldObject(context, label)
      );
      if (value === undefined)
        return failed(mailTextOf.unknownRecipient(label));
      recipients.push(value);
    }
    return post(context, read, recipients, {}, i => mailTextOf.sent(labels[i]));
  },
});

/** @type {ToolTableEntry} */
const replyEntry = harden({
  name: 'reply',
  site: 'guest',
  describe: () => descriptions.reply,
  available: mailAvailable,
  execute: async (request, ports, context) => {
    const read = await readMailArgs('reply', request, ports, context);
    if ('outcome' in read) return read.outcome;
    const number = read.values.get('messageNumber');
    const found = inboxMessageOf(context, number);
    if ('outcome' in found) return found.outcome;
    const { message } = found;
    return post(
      context,
      read,
      [message.from],
      { inReplyTo: message.postmark },
      () => mailTextOf.replied(number),
    );
  },
});

/** @type {ToolTableEntry} */
const dismissEntry = harden({
  name: 'dismiss',
  site: 'session',
  describe: () => descriptions.dismiss,
  available: mailAvailable,
  execute: async ({ args }, _ports, context) => {
    const read = readArgs('dismiss', args, specs.dismiss);
    if ('outcome' in read) return read.outcome;
    const number = read.values.get('messageNumber');
    const found = inboxMessageOf(context, number, true);
    if ('outcome' in found) return found.outcome;
    const answer = context.runtime.inbox.dismiss(number);
    return answer.refused === undefined
      ? ok(mailTextOf.dismissed(number))
      : failed(answer.refused);
  },
});

/** The entries of `toolTable` (D-M9-24), in `mailToolNames` order. */
export const mailToolEntries = harden([
  listMessagesEntry,
  sendEntry,
  replyEntry,
  dismissEntry,
]);
