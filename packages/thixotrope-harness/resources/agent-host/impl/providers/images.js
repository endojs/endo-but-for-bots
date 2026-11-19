// @ts-check
/**
 * Image results on the provider wires (the M8 contract,
 * `designs/m8-interfaces.md` sections 6.4 and 6.5; P-37; R4-32, R4-39).
 *
 * An image result is an ordinary staged tool result whose text is the
 * versioned envelope `IMAGE_ENVELOPE_PREFIX + {"mimeType","data"}`
 * (contract D-M8-8, hosted-agent `image-result.js`). This module is the one
 * place that recognises one in a projection (transcript records,
 * `../projection.js`) and turns it into each wire's native image input:
 *
 * - only a `tool-result` whose call (same `id`, earlier in the transcript)
 *   is named `viewImage` and which did not fail is decoded, so another
 *   tool's output that starts with the prefix stays text (D-M8-8);
 * - a malformed envelope is text, never a thrown error;
 * - at most `imageLimits.imagesPerRequest` image results go natively in one
 *   request, the newest (D-M8-9); older ones go as
 *   `imageTextOf.omittedReceipt`;
 * - an image of a turn that did not complete (`incomplete: true` on its
 *   entry, set by the projection) goes as `imageTextOf.incompleteReceipt`
 *   (R4-32).
 *
 * Every wire builder makes one `toolResultImages(transcript)` per request
 * and asks it once at its `tool-result` branch (seam S-19); the plan of
 * compaction sizes and summarizes the receipt instead of the envelope
 * (`imageReceiptText`, D-M8-14). Decoding parses the envelope and checks
 * the base64 alphabet (about 12 ms per 2 MiB, J-1010), so the decoded
 * images of the last `imagesPerRequest` envelopes are kept: the same staged
 * text answers the same string object round after round.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  IMAGE_ENVELOPE_PREFIX,
  imageMediaTypes,
  imageTextOf,
} from '../../../../guest/lib/interfaces.js';
import { imageLimits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/**
 * @typedef {{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp', data: string }} DecodedImage
 *   `data` is base64
 * @typedef {{ text: string, image?: DecodedImage }} ToolResultForm
 *   what a wire sends for one tool result: `image` when it goes natively
 *   (then `text` is its receipt), else `text` alone
 */

/** The tool whose results may hold an image (contract D-M8-8). */
const IMAGE_TOOL = 'viewImage';

/** Base64 characters of the largest image. */
const MAX_DATA_CHARS = 4 * Math.ceil(imageLimits.maxImageBytes / 3);

/** The largest envelope: the data, the JSON around it and the prefix. */
const MAX_ENVELOPE_CHARS = MAX_DATA_CHARS + 128;

const NOT_BASE64 = /[^A-Za-z0-9+/]/;

/**
 * The image of a parsed envelope body after hosted-agent `validate`'s
 * checks, or `undefined`.
 * @param {unknown} candidate
 * @returns {DecodedImage | undefined}
 */
const validImage = candidate => {
  const image = /** @type {any} */ (candidate);
  if (
    !image ||
    typeof image !== 'object' ||
    Array.isArray(image) ||
    Object.keys(image).length !== 2 ||
    !imageMediaTypes.includes(image.mimeType) ||
    typeof image.data !== 'string'
  )
    return undefined;
  /** @type {string} */
  const data = image.data;
  if (
    data.length === 0 ||
    data.length > MAX_DATA_CHARS ||
    data.length % 4 !== 0 ||
    NOT_BASE64.test(data.replace(/={1,2}$/, ''))
  )
    return undefined;
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  if ((data.length / 4) * 3 - padding > imageLimits.maxImageBytes)
    return undefined;
  return harden({ mediaType: image.mimeType, data });
};

/**
 * Decoded envelopes, newest last; `null` for an envelope that is not an
 * image. Bounded at `imagesPerRequest` entries (contract 6.4).
 * @type {Map<string, DecodedImage | null>}
 */
const decoded = new Map();

/**
 * The image an envelope text holds, or `undefined` (not an envelope, or a
 * malformed one). Never throws.
 * @param {unknown} content
 * @returns {DecodedImage | undefined}
 */
const decodeEnvelope = content => {
  if (
    typeof content !== 'string' ||
    !content.startsWith(IMAGE_ENVELOPE_PREFIX) ||
    content.length > MAX_ENVELOPE_CHARS
  )
    return undefined;
  const known = decoded.get(content);
  if (known !== undefined) {
    decoded.delete(content);
    decoded.set(content, known);
    return known ?? undefined;
  }
  /** @type {DecodedImage | undefined} */
  let image;
  try {
    image = validImage(JSON.parse(content.slice(IMAGE_ENVELOPE_PREFIX.length)));
  } catch {
    image = undefined;
  }
  decoded.set(content, image ?? null);
  if (decoded.size > imageLimits.imagesPerRequest) {
    const [oldest] = decoded.keys();
    decoded.delete(oldest);
  }
  return image;
};

/**
 * The envelope text a staged image result holds (used by the adapter's
 * `ImageTool`, `../tools/view-image.js`). The caller has checked the bytes
 * (magic bytes, at most 2 MiB); `data` is their base64.
 * @param {DecodedImage} image
 * @returns {string}
 */
export const encodeImageEnvelope = ({ mediaType, data }) =>
  IMAGE_ENVELOPE_PREFIX + JSON.stringify({ mimeType: mediaType, data });
harden(encodeImageEnvelope);

/**
 * Call id -> tool name of every `tool-call` of a transcript, made once per
 * transcript array.
 * @type {WeakMap<readonly any[], Map<string, string>>}
 */
const callNames = new WeakMap();

/** @param {readonly any[]} transcript */
const callNamesOf = transcript => {
  let names = callNames.get(transcript);
  if (names === undefined) {
    names = new Map();
    for (const record of transcript) {
      if (record?.kind === 'tool-call' && !names.has(record.id))
        names.set(record.id, record.name);
    }
    callNames.set(transcript, names);
  }
  return names;
};

/**
 * The image a transcript entry holds: a `tool-result` that did not fail,
 * whose call is named `viewImage`, and whose content is a valid envelope.
 * Anything else (another tool's output with the prefix, a malformed
 * envelope, a message) is text: `undefined`. Never throws.
 * @param {readonly any[]} transcript the projection the entry belongs to
 * @param {any} entry
 * @returns {DecodedImage | undefined}
 */
export const imageOf = (transcript, entry) => {
  if (
    entry?.kind !== 'tool-result' ||
    entry.failed === true ||
    typeof entry.content !== 'string' ||
    !entry.content.startsWith(IMAGE_ENVELOPE_PREFIX)
  )
    return undefined;
  if (callNamesOf(transcript).get(entry.id) !== IMAGE_TOOL) return undefined;
  return decodeEnvelope(entry.content);
};
harden(imageOf);

/**
 * The text an entry counts as wherever bytes are not sent (compaction's
 * sizing and summary input, D-M8-14): the receipt for an image result,
 * else the entry's content.
 * @param {readonly any[]} transcript
 * @param {any} entry
 * @returns {string}
 */
export const imageReceiptText = (transcript, entry) => {
  const image = imageOf(transcript, entry);
  return image === undefined
    ? String(entry?.content ?? '')
    : imageTextOf.receipt(image.mediaType);
};
harden(imageReceiptText);

/**
 * The image results a request sends natively: of turns not marked
 * `incomplete`, the newest `imagesPerRequest` (D-M8-9).
 * @param {readonly any[]} transcript
 * @returns {Set<any>}
 */
export const selectImages = transcript => {
  /** @type {Set<any>} */
  const selected = new Set();
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (selected.size >= imageLimits.imagesPerRequest) break;
    const entry = transcript[i];
    if (entry?.incomplete !== true && imageOf(transcript, entry) !== undefined)
      selected.add(entry);
  }
  return selected;
};
harden(selectImages);

/**
 * What each tool result of one request carries, for the wire builders:
 * made once per request, asked once per `tool-result` entry.
 * @param {readonly any[]} transcript
 * @returns {(entry: any) => ToolResultForm}
 */
export const toolResultImages = transcript => {
  const selected = selectImages(transcript);
  return entry => {
    const image = imageOf(transcript, entry);
    if (image === undefined) return { text: String(entry.content ?? '') };
    if (selected.has(entry))
      return { text: imageTextOf.receipt(image.mediaType), image };
    if (entry.incomplete === true)
      return { text: imageTextOf.incompleteReceipt(image.mediaType) };
    return {
      text: imageTextOf.omittedReceipt(
        image.mediaType,
        imageLimits.imagesPerRequest,
      ),
    };
  };
};
harden(toolResultImages);

/** @param {DecodedImage} image */
const dataUrl = image => `data:${image.mediaType};base64,${image.data}`;

/**
 * A Messages API `tool_result` content (the Anthropic API and the Claude
 * pool): one base64 image block, or the text.
 * @param {ToolResultForm} form
 * @returns {any[] | string}
 */
export const anthropicToolResultContent = ({ text, image }) =>
  image === undefined
    ? text
    : [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.data,
          },
        },
      ];
harden(anthropicToolResultContent);

/**
 * A Responses `function_call_output` output (the Codex pool): one
 * `input_image` with a data URL, or the text.
 * @param {ToolResultForm} form
 * @returns {any[] | string}
 */
export const responsesToolOutput = ({ text, image }) =>
  image === undefined
    ? text
    : [{ type: 'input_image', image_url: dataUrl(image), detail: 'auto' }];
harden(responsesToolOutput);

/**
 * OpenAI-compatible chat (OpenRouter) has no image in a `tool` message: the
 * tool message carries the receipt, and one synthetic user message after
 * the round's tool messages carries the images (lal
 * `openai-compatible-messages.js`, 1315bef86). Answers that message, or
 * nothing when no image is waiting.
 * @param {readonly { id: string, image: DecodedImage }[]} images
 * @returns {any[]}
 */
export const chatImageMessages = images =>
  images.length === 0
    ? []
    : [
        {
          role: 'user',
          content: images.flatMap(({ id, image }) => [
            { type: 'text', text: `Image returned by tool call ${id}:` },
            { type: 'image_url', image_url: { url: dataUrl(image) } },
          ]),
        },
      ];
harden(chatImageMessages);
