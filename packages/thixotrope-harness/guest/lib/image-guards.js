// @ts-check
/**
 * Image input, the adapter's side (Node only): the image envelope, the
 * `ImageTool` and `ImageSource` guards, and the fixed texts of reading,
 * checking and sending images (the M8 contract, `designs/m8-interfaces.md`
 * sections 3.4, 6 and 9; P-37; R3-30, R4-39, R4-32).
 *
 * No vat program imports this module, so none of it costs session program
 * bytes; the session's `viewImage` entry reads `./guards/images.js`. Read
 * by the agent-host adapter (`AH/tools/view-image.js`,
 * `AH/providers/images.js`) and by the resources that offer image sources
 * (M6's workspace files build their exos with `ImageSource`). Not
 * browser-sendable: `./vocabulary-tables.js` names it among the exclusions
 * if its test asks (contract seam G-4).
 *
 * Constants and guard builders only. The builders take a getter of the
 * table that holds them (`./guards/context.js` explains why); the adapter
 * builds them with `lazyTable` until the fold moves them into the Node-side
 * table `./interfaces.js` (contract section 18). A Node process installs
 * the guest prelude before importing this module, as for `./interfaces.js`.
 */
import { text, list, record, count } from './guards/base.js';
import { imageLimits } from './guards/images.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

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

// ---------------------------------------------------------------- texts

/** Fixed texts (Fae `image-tool.js` and hosted-agent `image-result.js`). */
export const imageTexts = harden({
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
