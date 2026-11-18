// @ts-check
/**
 * Image input through `viewImage`: the tool's description and argument
 * names, the image envelope, the `ImageTool` and `ImageSource` guards,
 * fixed texts and limits (the M8 contract, `designs/m8-interfaces.md`
 * sections 3.4, 6 and 9; P-37; R3-30, R4-39, R4-32).
 *
 * Image bytes never enter a vat (architecture section 0, the frame ceiling
 * CC-027): the session vat resolves the label and hands the target object
 * to the agent-host adapter's `ImageTool`, which reads the bytes, checks
 * them and stages the envelope as a Blob; the vat sees a `ToolOutcome`
 * whose text is that StagedText, with the receipt as its preview.
 *
 * Read by the session vat (the `viewImage` entry: description, argument
 * names, argument texts) and by the agent-host adapter (everything else).
 * Constants and guard builders only. The interface builders take a getter
 * of the table that holds them (`./context.js` explains why); the adapter
 * builds them with `lazyTable` until the fold moves them into the Node-side
 * table `../interfaces.js` (contract section 15).
 *
 * Guest rules.
 */
import { text, list, record, count } from './base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

// ---------------------------------------------------------------- limits

export const imageLimits = harden({
  /** R4-39: the largest image, bytes (hosted-agent `image-result.js:8`). */
  maxImageBytes: 2 * 1024 * 1024,
  /**
   * Raw bytes asked of an `ImageSource` per `readBase64` call (an answer
   * of 262,144 base64 characters; it travels toward the adapter, never
   * into a vat).
   */
  readPageBytes: 196_608,
  /** Empty pages before a source is refused (Fae `image-tool.js:125`). */
  maxEmptyReads: 64,
  /** The whole read, from the first call to the last page (ms). */
  readTimeoutMs: 30_000,
  /**
   * Images sent natively per provider request, newest first; older image
   * results are sent as their receipt (contract D-M8-9, open question Q-2).
   */
  imagesPerRequest: 20,
  /** `petName` (Fae `image-tool.js:46`). */
  petNameUnits: 256,
  /** `path` segments and their length (Fae `image-tool.js:51-53`). */
  pathSegments: 64,
  segmentUnits: 255,
  /**
   * The raw `path` text the vat passes on: the arguments of a local tool
   * are at most `inlineBytes` (staged arguments are refused, M5 2.4.2),
   * so a path of 64 segments of 255 characters is refused as too large;
   * the bound only caps the guard.
   */
  pathTextUnits: 8192,
});

/** R4-39: the formats accepted, recognised by their magic bytes. */
export const imageMediaTypes = harden([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * The versioned envelope a staged image result holds (hosted-agent
 * `image-result.js:7`): this prefix, then the JSON text
 * `{"mimeType":"image/png","data":"<base64>"}`. Only results of the
 * `viewImage` tool are decoded (contract D-M8-8).
 */
export const IMAGE_ENVELOPE_PREFIX = '\u001eendo-image-v1\n';

// ---------------------------------------------------------------- the tool

/** Closed argument names (R3-26; Fae `image-tool.js:44-56`). */
export const viewImageArgumentNames = harden(['petName', 'path']);

/**
 * The tool as offered to the model (R3-30; Fae `image-tool.js:38-58`,
 * adapted: a held image source or a workspace, no Endo blob or mount).
 */
export const viewImageDescription = harden({
  name: 'viewImage',
  description:
    'Read a PNG, JPEG or WebP through an already-held capability and see it as image input (requires a vision-capable model). Use petName for an image source or a workspace; path is an optional array of relative file segments inside a workspace. Example: {"petName":"workspace","path":["screenshots","mobile.png"]}. Maximum 2 MiB; resize larger images first. For visual development, render in a browser, save desktop/mobile screenshots into the workspace, call viewImage, inspect browser errors, and iterate. Source code or a syntax check alone does not verify the rendered scene. This tool does not render HTML or fetch URLs.',
  parameters: JSON.stringify({
    type: 'object',
    additionalProperties: false,
    properties: {
      petName: { type: 'string', minLength: 1, maxLength: 256 },
      path: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: { type: 'string', minLength: 1, maxLength: 255 },
      },
    },
    required: ['petName'],
  }),
});

// ---------------------------------------------------------------- texts

/** Fixed texts (Fae `image-tool.js` and hosted-agent `image-result.js`). */
export const imageTexts = harden({
  /** Fae `image-tool.js:73`. */
  badPetName: 'petName must be a nonempty name of at most 256 characters',
  /** Fae `image-tool.js:91`. */
  badPath: 'path must contain relative file segments, not a host path',
  /** Fae `image-tool.js:108`, `:129`. */
  tooLarge: 'Image exceeds the 2 MiB limit; resize it before reading',
  /** Fae `image-tool.js:111`, adapted to the harness's source method. */
  notReadable:
    'Image capability must expose readBase64(); use a workspace file or an image source',
  /** Fae `image-tool.js:125`. */
  tooManyEmptyReads: 'Image stream yielded too many empty chunks',
  /** Fae `image-tool.js:28`. */
  unsupported:
    'Unsupported image bytes. Render or convert to PNG, JPEG or WebP first; SVG and HTML are not raster images.',
  /** The source answered something that is not a page of base64. */
  badPage: 'Image source answered an unreadable page',
  /** `imageLimits.readTimeoutMs`. */
  readTimeout: 'Image read timed out; try again or use a smaller image',
  /** The source's vat or adapter is gone (a retired break from a guest). */
  sourceLost: 'Image source is no longer reachable',
  /** The path names nothing, or the workspace refused it. */
  notFound: 'No image at that path',
  /** Staging the envelope failed (quota, disk). */
  notStaged: 'Image could not be kept for model input',
  /** hosted-agent `image-result.js:68`: a preview of an image result. */
  receiptUnknownFormat: '[Image result; bytes retained for model input]',
});

/** Fixed texts with parameters. */
export const imageTextOf = harden({
  /**
   * The receipt the model's transcript, the UI and history show for an
   * image result (hosted-agent `image-result.js:71`).
   * @param {string} mediaType
   */
  receipt: mediaType => `[Image ${mediaType}; bytes retained for model input]`,
  /**
   * R4-32: an image of a turn that did not complete, on an API backend.
   * @param {string} mediaType
   */
  incompleteReceipt: mediaType =>
    `[Image ${mediaType} from an incomplete turn; not sent again]`,
  /**
   * Contract D-M8-9: an image older than the newest `imagesPerRequest`.
   * @param {string} mediaType
   * @param {number} kept
   */
  omittedReceipt: (mediaType, kept) =>
    `[Image ${mediaType} omitted from this request: only the newest ${kept} images are sent]`,
});

// ---------------------------------------------------------------- guards

/**
 * Shape builders; `table()` answers the table that holds them and the
 * session's shapes (`Id`, `ToolOutcome`).
 * @param {() => any} table
 */
export const imageShapeBuilders = table => ({
  /**
   * `ImageTool.view` argument (session vat -> adapter). `target` is the
   * object the label names in the session, never a name. `path` is the
   * model's raw JSON text of the `path` argument, as the vat received it
   * (a vat never parses model JSON, architecture rule 12.10; the adapter
   * parses it and applies Fae's segment checks).
   */
  ImageRequest: () =>
    record(
      { opId: table().Id, target: M.remotable('ImageTarget') },
      { path: text(imageLimits.pathTextUnits) },
    ),
  /** The path as the adapter uses it, after parsing and checking. */
  ImagePath: () =>
    list(text(imageLimits.segmentUnits), imageLimits.pathSegments),
  /** `ImageSource.readBase64` argument: raw byte offset and count. */
  ImageReadRange: () => record({ offset: count, maxBytes: count }),
  /** `ImageSource.readBase64` answer: base64 of at most `maxBytes` bytes. */
  ImageReadPage: () =>
    record({
      data: text(4 * Math.ceil(imageLimits.readPageBytes / 3)),
      done: M.boolean(),
    }),
});

/**
 * Interface builders.
 * @param {() => any} table
 */
export const imageInterfaceBuilders = table => ({
  /**
   * The agent-host adapter's per-session image tool, offered in
   * `TurnPorts.tools` under the name `viewImage`. It answers a
   * `ToolOutcome` for every refusal and never rejects for one (a
   * rejection from an adapter tool is the session's restart signal).
   */
  ImageTool: () =>
    M.interface('ImageTool', {
      view: M.callWhen(table().ImageRequest).returns(table().ToolOutcome),
    }),
  /**
   * What an image source offers (M6's workspace files, an operator's
   * source). `size` is optional for a source; the adapter calls it only
   * when the source lists it.
   */
  ImageSource: () =>
    M.interface('ImageSource', {
      readBase64: M.callWhen(table().ImageReadRange).returns(
        table().ImageReadPage,
      ),
      size: M.callWhen().returns(count),
    }),
});

/** Method names per interface. */
export const imageMethodNames = harden({
  ImageTool: harden(['view']),
  ImageSource: harden(['readBase64', 'size']),
});
