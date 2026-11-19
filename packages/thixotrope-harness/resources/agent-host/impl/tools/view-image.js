// @ts-check
/**
 * The `viewImage` adapter tool: the agent-host adapter's per-session
 * `ImageTool` (P-37; R3-30, R4-39; `designs/m8-interfaces.md` 6.2, 6.3, 9
 * and 14).
 *
 * The session vat resolves the model's label to an object and calls
 * `view({ opId, target, path? })`, with `path` the model's raw JSON text
 * (a vat never parses model JSON, rule 12.10). This tool parses and checks
 * the path, descends through the target (`openImage(path)`, the
 * workspace's read method, seam X-1; else `lookup(path)`), reads the
 * source's `readBase64` pages into one bounded buffer, checks the magic
 * bytes and stages the versioned envelope (`providers/images.js`
 * `encodeImageEnvelope`) as a Blob owned by the session. The answer is an
 * ordinary `ToolOutcome` whose text is that StagedText with the receipt as
 * its preview (D-M8-8): image bytes never enter a vat.
 *
 * Every refusal is a `failed` outcome with a fixed text, never a
 * rejection (a rejection from an adapter tool is the session's restart
 * signal, rule 12.8); a retired break from the target or the source is
 * `imageTexts.sourceLost`.
 *
 * Bounds (contract 9): the path is 1-64 segments of 1-255 units checked
 * before any call on the target; a source's `size()` over 2 MiB refuses
 * before any read; each page asks at most `readPageBytes`, never more than
 * one byte past the limit in all, so a larger source stops at 2 MiB + 1;
 * a page is checked before it is decoded; 64 empty pages; the descent and
 * the read together end at `readTimeoutMs`. A source in a vat answers
 * short pages (at most 15,360 bytes, D-M8-21): the read advances by what
 * each page decoded. Nothing outlives a call: the exo holds no state.
 *
 * Node only.
 */
import { Buffer } from 'node:buffer';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { shapes } from '../../../../guest/lib/interfaces.js';
import { lazyTable } from '../../../../guest/lib/guards/base.js';
import { imageLimits } from '../../../../guest/lib/guards/images.js';
import {
  imageInterfaceBuilders,
  imageShapeBuilders,
  imageTextOf,
  imageTexts,
} from '../../../../guest/lib/image-guards.js';
import { isRetiredBreak } from '../../../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import { encodeImageEnvelope } from '../providers/images.js';

const { E, makeExo, matches } = /** @type {any} */ (globalThis);

/**
 * The image guards (`ImageRequest`, `ImagePath`, `ImageReadRange`,
 * `ImageReadPage`, `ImageTool`, `ImageSource`), built on first use, with
 * the adapter's shapes (`Id`, `ToolOutcome`) readable through it. Image
 * sources built in Node (an adapter-side workspace file, test peers) take
 * `imageGuards.ImageSource` from here.
 * @type {any}
 */
export const imageGuards = lazyTable(
  {
    ...imageShapeBuilders(() => imageGuards),
    ...imageInterfaceBuilders(() => imageGuards),
  },
  shapes,
);

// ---------------------------------------------------------------- formats

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

// ---------------------------------------------------------------- the path

/** Characters no segment may hold (Fae `image-tool.js:51-56`). */
const FORBIDDEN = /[/\\\0]/;

/**
 * Parse and check the model's `path` text: a JSON array of 1-64 strings
 * of 1-255 units, none `.` or `..`, none holding `/`, `\` or NUL. Returns
 * the checked array (an `ImagePath`), or `undefined`.
 * @param {string} text
 * @returns {string[] | undefined}
 */
const parsePath = text => {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > imageLimits.pathSegments
  )
    return undefined;
  for (const segment of parsed) {
    if (
      typeof segment !== 'string' ||
      segment.length < 1 ||
      segment.length > imageLimits.segmentUnits ||
      segment === '.' ||
      segment === '..' ||
      FORBIDDEN.test(segment)
    )
      return undefined;
  }
  const path = harden(/** @type {string[]} */ (parsed));
  return matches(path, imageGuards.ImagePath) ? path : undefined;
};

// ---------------------------------------------------------------- reading

/** A refusal: the fixed text the outcome carries. */
class Refusal {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
  }
}

/**
 * A rejection of a call on the target or the source as a refusal: a
 * retired break is `sourceLost`, anything else `otherwise`.
 * @param {string} otherwise
 */
const refuseWith = otherwise => (/** @type {unknown} */ error) => {
  throw new Refusal(isRetiredBreak(error) ? imageTexts.sourceLost : otherwise);
};

/**
 * The method names an object lists, or a refusal.
 * @param {any} target
 * @param {string} otherwise
 * @returns {Promise<string[]>}
 */
const methodNamesOf = async (target, otherwise) => {
  // eslint-disable-next-line no-underscore-dangle
  const asked = E(target).__getMethodNames__();
  const names = await asked.catch(refuseWith(otherwise));
  if (!Array.isArray(names)) throw new Refusal(otherwise);
  return names;
};

/** The base64 alphabet with padding at the end only. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode one page answer asked with `maxBytes`, or refuse `badPage`.
 * @param {unknown} page
 * @param {number} maxBytes
 */
const decodePage = (page, maxBytes) => {
  if (typeof page !== 'object' || page === null)
    throw new Refusal(imageTexts.badPage);
  const { data, done } = /** @type {{ data?: unknown, done?: unknown }} */ (
    page
  );
  if (
    typeof data !== 'string' ||
    typeof done !== 'boolean' ||
    data.length > 4 * Math.ceil(maxBytes / 3) ||
    data.length % 4 !== 0 ||
    !BASE64.test(data)
  )
    throw new Refusal(imageTexts.badPage);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > maxBytes) throw new Refusal(imageTexts.badPage);
  return { bytes, done };
};

/**
 * Read the whole image from `source` into a buffer of at most
 * `maxImageBytes`, or refuse. `live()` turns false when the deadline has
 * passed: the loop then stops calling the source.
 * @param {any} source
 * @param {() => boolean} live
 */
const readImage = async (source, live) => {
  const names = await methodNamesOf(source, imageTexts.notReadable);
  if (!names.includes('readBase64')) throw new Refusal(imageTexts.notReadable);
  const max = imageLimits.maxImageBytes;
  if (names.includes('size')) {
    /** @type {unknown} */
    const size = await E(source).size().catch(refuseWith(imageTexts.badPage));
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      throw new Refusal(imageTexts.badPage);
    if (size > max) throw new Refusal(imageTexts.tooLarge);
  }
  const buffer = Buffer.alloc(max);
  let offset = 0;
  let empty = 0;
  for (;;) {
    if (!live()) throw new Refusal(imageTexts.readTimeout);
    // Never ask past one byte over the limit: a larger source stops there.
    const maxBytes = Math.min(imageLimits.readPageBytes, max + 1 - offset);
    // eslint-disable-next-line no-await-in-loop
    const page = await E(source)
      .readBase64(harden({ offset, maxBytes }))
      .catch(refuseWith(imageTexts.badPage));
    const { bytes, done } = decodePage(page, maxBytes);
    if (offset + bytes.length > max) throw new Refusal(imageTexts.tooLarge);
    buffer.set(bytes, offset);
    offset += bytes.length;
    if (done) break;
    if (bytes.length === 0) {
      empty += 1;
      if (empty > imageLimits.maxEmptyReads)
        throw new Refusal(imageTexts.tooManyEmptyReads);
    }
  }
  return buffer.subarray(0, offset);
};

/**
 * The source the request names: the target itself without a path, else
 * the target's `openImage(path)` (a workspace, seam X-1) or `lookup(path)`
 * (a directory-like object).
 * @param {any} target
 * @param {string[] | undefined} path
 */
const sourceOf = async (target, path) => {
  if (path === undefined) return target;
  const names = await methodNamesOf(target, imageTexts.notFound);
  const method = ['openImage', 'lookup'].find(name => names.includes(name));
  if (method === undefined) throw new Refusal(imageTexts.notFound);
  return E(target)[method](path).catch(refuseWith(imageTexts.notFound));
};

// ---------------------------------------------------------------- the tool

/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/**
 * @param {object} options
 * @param {import('../blobs.js').BlobStore} options.blobs the session's
 *   blob store (its staging is charged to `session`)
 * @param {any} options.session the Session the envelope is staged for
 * @param {import('../timers.js').Timers} options.timers the read's deadline
 * @param {import('../providers/event-log.js').EventLog} [options.log]
 *   `image-view-start`, `image-view-end`, `image-view-refused`
 */
export const makeImageTool = ({ blobs, session, timers, log = () => {} }) =>
  makeExo('ImageTool', imageGuards.ImageTool, {
    /** @param {{ opId: string, target: any, path?: string }} request */
    view: async ({ opId, target, path: pathText }) => {
      log('image-view-start', { opId, path: pathText !== undefined });
      const path = pathText === undefined ? undefined : parsePath(pathText);
      if (pathText !== undefined && path === undefined) {
        log('image-view-refused', { opId, reason: 'badPath' });
        return failed(imageTexts.badPath);
      }
      let live = true;
      /** @type {() => void} */
      let cancel = () => {};
      /** @type {Promise<never>} */
      const deadline = new Promise((_, reject) => {
        cancel = timers.after(imageLimits.readTimeoutMs, () => {
          live = false;
          reject(new Refusal(imageTexts.readTimeout));
        });
      });
      const viewed = async () => {
        const bytes = await Promise.race([
          sourceOf(target, path).then(source => readImage(source, () => live)),
          deadline,
        ]);
        cancel();
        const mediaType = imageTypeOf(bytes);
        if (mediaType === undefined) throw new Refusal(imageTexts.unsupported);
        const envelope = encodeImageEnvelope({
          mediaType,
          data: bytes.toString('base64'),
        });
        const staged = await blobs
          .stage(envelope, { owner: session })
          .catch(() => {
            throw new Refusal(imageTexts.notStaged);
          });
        log('image-view-end', { opId, mediaType, bytes: bytes.length });
        return harden({
          status: 'ok',
          text: { ...staged, preview: imageTextOf.receipt(mediaType) },
        });
      };
      /** @param {unknown} error */
      const refused = error => {
        cancel();
        live = false;
        if (!(error instanceof Refusal)) throw error;
        log('image-view-refused', { opId, text: error.text });
        return failed(error.text);
      };
      return viewed().catch(refused);
    },
  });
harden(makeImageTool);
