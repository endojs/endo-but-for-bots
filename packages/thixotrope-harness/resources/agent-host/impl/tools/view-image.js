// @ts-check
/**
 * The `viewImage` adapter tool: the agent-host adapter's per-session
 * `ImageTool` (P-37; R3-30, R4-39; `designs/m8-interfaces.md` 6.2).
 *
 * Not built yet: `view` refuses every request with
 * `imageTexts.notReadable`. This export lets the adapter register the tool
 * before the reading is built.
 *
 * Node only.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { shapes } from '../../../../guest/lib/interfaces.js';
import { lazyTable } from '../../../../guest/lib/guards/base.js';
import {
  imageInterfaceBuilders,
  imageShapeBuilders,
  imageTexts,
} from '../../../../guest/lib/image-guards.js';
/* eslint-enable import/no-relative-packages */

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * The image guards (`ImageRequest`, `ImagePath`, `ImageReadRange`,
 * `ImageReadPage`, `ImageTool`, `ImageSource`), built on first use, with
 * the adapter's shapes (`Id`, `ToolOutcome`) readable through it.
 * @type {any}
 */
export const imageGuards = lazyTable(
  {
    ...imageShapeBuilders(() => imageGuards),
    ...imageInterfaceBuilders(() => imageGuards),
  },
  shapes,
);

/** The leading bytes of each accepted format (Fae `image-tool.js` `imageType`). */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * @param {Uint8Array} bytes
 * @param {number[]} magic
 * @param {number} [at]
 */
const startsWith = (bytes, magic, at = 0) =>
  bytes.length >= at + magic.length &&
  magic.every((byte, i) => bytes[at + i] === byte);

/**
 * The media type the bytes' magic names, or `undefined` (SVG, HTML and
 * every other format).
 * @param {Uint8Array} bytes
 * @returns {'image/png' | 'image/jpeg' | 'image/webp' | undefined}
 */
export const imageTypeOf = bytes => {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8))
    return 'image/webp';
  return undefined;
};
harden(imageTypeOf);

/**
 * @param {object} options
 * @param {import('../blobs.js').BlobStore} options.blobs the session's
 *   blob store (staging owned by `session`)
 * @param {any} options.session the Session the envelope is staged for
 * @param {import('../timers.js').Timers} options.timers
 * @param {import('../providers/event-log.js').EventLog} [options.log]
 */
export const makeImageTool = ({
  blobs: _blobs,
  session: _session,
  timers: _timers,
  log: _log,
}) =>
  makeExo('ImageTool', imageGuards.ImageTool, {
    view: async () =>
      harden({ status: 'failed', text: imageTexts.notReadable }),
  });
harden(makeImageTool);
