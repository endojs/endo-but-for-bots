// @ts-check
/**
 * Every read and write of agent-host blobs by the environments adapter
 * (`designs/m6-interfaces.md` D-M6-6, the spike seam). A command's result
 * over `inlineBytes` is written through the `BlobWriters` the session
 * passed with the call (agent-host adapter objects: pieces go adapter to
 * adapter through the hub), and staged model arguments are read through
 * the `Content` passed with it. No byte of either enters a vat.
 *
 * If the owner adopts the data-reference spike's step 1, this module's
 * backing changes to the blob store directory and the resolve amplifier,
 * and nothing that imports it changes.
 *
 * Node only (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { chunkText } from '../../../guest/lib/bounded.js';
import { limits } from '../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {{ blob: object, preview: string, bytes: number, digest?: string }} StagedText
 */

/**
 * Write `text` to a new blob through `writers`, in pieces of at most
 * `blobPieceBytes` (one answered append each), and answer its
 * `StagedText`. A failure aborts the writer and rejects.
 *
 * @param {string} text
 * @param {any} writers a `BlobWriters`
 * @returns {Promise<StagedText>}
 */
export const stageText = async (text, writers) => {
  const writer = await E(writers).open();
  try {
    for (const piece of chunkText(text, limits.blobPieceBytes)) {
      // eslint-disable-next-line no-await-in-loop -- one answered piece at a time
      await E(writer).append(piece);
    }
    return await E(writer).close();
  } catch (error) {
    E.sendOnly(writer).abort();
    throw error;
  }
};
harden(stageText);

/**
 * The whole text of a staged value, read through `content` in pages of at
 * most `blobPageBytes`. Rejects when the text is over `maxBytes` (by its
 * declared size, before any read, or by its pages), or when its pages stop
 * advancing before the end.
 *
 * @param {StagedText} staged
 * @param {any} content a `Content`
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export const readStaged = async (staged, content, maxBytes) => {
  const tooLarge = () =>
    Error(`staged text too large (${staged.bytes} bytes; limit ${maxBytes})`);
  if (staged.bytes > maxBytes) throw tooLarge();
  /** @type {string[]} */
  const pages = [];
  let offset = 0;
  const reads = Math.ceil(maxBytes / limits.blobPageBytes) + 2;
  await null;
  for (let read = 0; read < reads; read += 1) {
    /** @type {{ text: string, next: number, done: boolean }} */
    // eslint-disable-next-line no-await-in-loop -- one answered page at a time
    const page = await E(content).read(
      staged.blob,
      harden({ offset, maxBytes: limits.blobPageBytes }),
    );
    if (page.next > maxBytes) throw tooLarge();
    pages.push(page.text);
    if (page.done) return pages.join('');
    if (page.next <= offset) break;
    offset = page.next;
  }
  throw Error('staged text could not be read: its pages did not reach its end');
};
harden(readStaged);
