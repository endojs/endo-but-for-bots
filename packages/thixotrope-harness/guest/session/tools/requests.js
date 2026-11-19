// @ts-check
/**
 * The typed-request tools (designs/m9-interfaces.md 3.2, 4.5, D-M9-17;
 * R3-34, R3-216, R3-217): `resolveRequest`, `rejectRequest`, `submitForm`,
 * static entries of the tool table offered while the session holds its
 * `Outbox`. Each answers the message's `RequestTicket` (a factory exo,
 * `site: 'guest'`): `answer({ json })`, `answer({ rejected })` or
 * `submit(values)`. The inbox part marks the request settled first
 * (`settleRequest`), so its settle hook does not reject it, and is told
 * the ticket's answer: a refusal opens the request again, so it can be
 * retried. A request already settled is forwarded to its ticket, whose
 * refusal (`requestClosed`, the factory's text) is the tool's result.
 *
 * `messageNumber` is a decimal string (Fae) or an integer. A form's values
 * are read with a closed spec built from its fields (an unknown name is
 * refused before anything is built), a missing value takes the field's
 * default, each value is checked against its kind and sent as JSON text of
 * that kind; a `decimal` becomes a digit string.
 *
 * Guest rules: model JSON never becomes a record; no `JSON.parse`.
 */
import { mailTextOf, mailTexts } from '../../lib/guards/mail.js';
import { mailLimits } from '../../lib/mail-limits.js';
import { limits } from '../../lib/limits.js';
import { parseClosedArgs } from '../../lib/tool-args.js';
import { messageOf, utf8Bytes } from '../../lib/bounded.js';
import { readArgs } from './objects.js';
import {
  failed,
  inboxMessageOf,
  mailAvailable,
  mailSpec,
  ok,
  params,
} from './mail.js';

/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * The JSON text of a form field's kind from the value's source span, or
 * undefined when the span is not of that kind.
 * @type {Record<string, (span: string) => string | undefined>}
 */
const ofKind = {
  string: span => (span[0] === '"' ? span : undefined),
  boolean: span => (span === 'true' || span === 'false' ? span : undefined),
  integer: span =>
    /^-?(0|[1-9]\d*)$/.test(span) && Number.isSafeInteger(Number(span))
      ? span
      : undefined,
  decimal: span => {
    const digits = /^(-?\d+)$|^"(-?\d+)"$/.exec(span);
    return digits ? `"${digits[1] ?? digits[2]}"` : undefined;
  },
};

/**
 * One request tool: read the arguments, find the message of `type`, then
 * `answer(values, message)` -> `{ json }` (the ticket's `answer` argument
 * or `submit` list) or `{ outcome }`; the inbox settles the request and the
 * ticket is called.
 * @param {string} name
 * @param {'request' | 'form'} type
 * @param {string} text
 * @param {string} parameter the second argument's schema, JSON text of its
 *   property
 * @param {(values: Map<string, any>, message: any) => any} answer
 * @param {string} done the result text
 * @returns {ToolTableEntry}
 */
const requestEntry = (name, type, text, parameter, answer, done) => {
  const spec = mailSpec(name, 2, [
    'raw',
    name === 'rejectRequest' ? 'string' : 'raw',
  ]);
  const description = harden({
    name,
    description: text,
    parameters: params(
      `"messageNumber":{"type":"string","description":"The message number (decimal)."},${parameter}`,
      `["messageNumber","${spec.fields[1].name}"]`,
    ),
  });
  return harden({
    name,
    site: 'guest',
    describe: () => description,
    available: mailAvailable,
    execute: async ({ args }, _ports, context) => {
      const read = readArgs(name, args, spec);
      if ('outcome' in read) return read.outcome;
      const digits = /^(\d{1,15})$|^"(\d{1,15})"$/.exec(
        read.values.get('messageNumber'),
      );
      if (!digits) return failed(mailTexts.expectedDecimal);
      const number = Number(digits[1] ?? digits[2]);
      const found = inboxMessageOf(context, number);
      if ('outcome' in found) return found.outcome;
      const { message } = found;
      if (message.type !== type) {
        return failed(
          type === 'request'
            ? mailTexts.expectedRequest
            : mailTexts.expectedForm,
        );
      }
      const made = answer(read.values, message);
      if (made.outcome) return made.outcome;
      const claim = context.runtime.inbox.settleRequest(number);
      const ticket = claim?.ticket ?? message.ticket;
      await null;
      try {
        await (type === 'form'
          ? E(ticket).submit(made.json)
          : E(ticket).answer(made.json));
        claim?.settled(true);
        return ok(done);
      } catch (error) {
        claim?.settled(false);
        return failed(messageOf(error));
      }
    },
  });
};

/**
 * `{ outcome }` when the JSON text is over `requestAnswerBytes`.
 * @param {string} json
 */
const tooLarge = json => {
  const bytes = utf8Bytes(json);
  return bytes > mailLimits.requestAnswerBytes
    ? {
        outcome: failed(
          mailTextOf.answerTooLarge(bytes, mailLimits.requestAnswerBytes),
        ),
      }
    : undefined;
};

/** The entries of `toolTable` (D-M9-24), in `requestToolNames` order. */
export const requestToolEntries = harden([
  requestEntry(
    'resolveRequest',
    'request',
    'Answer a typed request message from your inbox with a JSON value.',
    '"value":{"description":"The answer (any JSON value)."}',
    values => {
      const json = values.get('value');
      return tooLarge(json) ?? { json: harden({ json }) };
    },
    mailTexts.requestAnswered,
  ),
  requestEntry(
    'rejectRequest',
    'request',
    'Reject a typed request message from your inbox.',
    '"reason":{"type":"string","description":"Why it is rejected."}',
    values => ({
      json: harden({
        rejected: values.get('reason').slice(0, limits.reasonUnits),
      }),
    }),
    mailTexts.requestRejected,
  ),
  requestEntry(
    'submitForm',
    'form',
    "Submit a form message from your inbox: one value per field, of the field's kind.",
    '"values":{"type":"object","description":"Field name to value."}',
    (values, message) => {
      const fields = message.fields ?? [];
      const parsed = parseClosedArgs(values.get('values'), {
        tool: 'submitForm',
        fields: fields.map((/** @type {any} */ f) => ({
          name: f.name,
          kind: 'raw',
        })),
      });
      if (!parsed.ok) return { outcome: failed(parsed.text) };
      const submitted = [];
      for (const { name, kind, default: fallback } of fields) {
        const span = parsed.values.get(name) ?? fallback;
        if (span === undefined) {
          return { outcome: failed(mailTextOf.formFieldMissing(name)) };
        }
        const json = ofKind[kind](span);
        if (json === undefined) {
          return { outcome: failed(mailTextOf.formFieldKind(name, kind)) };
        }
        const big = tooLarge(json);
        if (big) return big;
        submitted.push(harden({ name, json }));
      }
      return { json: harden(submitted) };
    },
    mailTexts.formSubmitted,
  ),
]);
