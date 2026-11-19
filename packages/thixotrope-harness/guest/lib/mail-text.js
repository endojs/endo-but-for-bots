// @ts-check
/**
 * The texts a session composes from its inbox (designs/m9-interfaces.md
 * 3.2): the `listMessages` answer, a mail turn's input and its note. The
 * fixed words are `mailTextOf` in `./guards/mail.js`; this module only puts
 * an inbox message's fields into them. The stray-body cut is the post
 * office's, not this module's.
 *
 * Guest rules: plain functions, no record key from data (a row's keys are
 * fixed; JSON is built here and leaves as text).
 */
import { mailLimits } from './mail-limits.js';
import { mailTextOf } from './guards/mail.js';
import { limits } from './limits.js';
import { boundToolOutput, previewText } from './bounded.js';

/**
 * What `InboxPart.views` answers per message, newest first.
 * @typedef {object} InboxView
 * @property {number} number
 * @property {string} type
 * @property {string} fromTitle
 * @property {any} body inline text or a StagedText
 * @property {readonly string[]} edges the attachment labels
 * @property {string} state
 * @property {number} at
 */

/**
 * Units of one row's text in a listing: the tool limit shared by a full
 * page, less room for the row's other fields.
 */
const rowTextUnits =
  Math.floor(limits.toolOutputUnits / mailLimits.listMessagesPage) - 256;

/**
 * A body as text: an inline body itself, a staged one by its preview.
 * @param {any} body
 * @returns {string}
 */
export const bodyText = body =>
  typeof body === 'string' ? body : body.preview;
harden(bodyText);

/**
 * The `listMessages` answer: a JSON array of Fae's rows `{ number, from,
 * type, text, edgeNames }` plus `state`, each text cut to its share of the
 * tool limit, the whole bounded as any tool output (R4-46).
 * @param {readonly InboxView[]} views
 * @returns {string}
 */
export const listingText = views =>
  boundToolOutput(
    JSON.stringify(
      views.map(view => ({
        number: view.number,
        from: view.fromTitle,
        type: view.type,
        text: previewText(bodyText(view.body), rowTextUnits),
        edgeNames: view.edges,
        state: view.state,
      })),
    ),
  );
harden(listingText);

/**
 * A mail turn's input (R4-58): a package's body as it came (inline or
 * staged), a request's or form's composed text.
 * @param {{ number: number, type: string, body: any, fields?: readonly { name: string }[] }} message
 * @returns {any}
 */
export const mailTurnInput = ({ number, type, body, fields }) =>
  type === 'request' || type === 'form'
    ? mailTextOf.requestTurnText(
        type,
        number,
        bodyText(body),
        (fields ?? []).map(field => field.name),
      )
    : body;
harden(mailTurnInput);

/**
 * A mail turn's system note (R4-58, D-M9-7): the attachments' edge names
 * and the adopt hint, or undefined when the message attaches nothing.
 * @param {{ number: number, edges: readonly string[] }} message
 * @returns {string | undefined}
 */
export const mailTurnNote = ({ number, edges }) =>
  edges.length > 0 ? mailTextOf.packageNote(number, edges) : undefined;
harden(mailTurnNote);
