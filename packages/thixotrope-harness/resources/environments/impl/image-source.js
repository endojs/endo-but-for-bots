// @ts-check
/**
 * Workspace images (contract `designs/m6-interfaces.md` 3.3, 3.4 "openImage",
 * 5.2; seam X-1 with M8's `viewImage`, spec R3-30): an adapter-side
 * `ImageSource` over one worktree file, built with M8's guard
 * (`guest/lib/image-guards.js`), so its pages go adapter to adapter and no
 * image byte enters a vat on the tool path.
 *
 * `openImage` is what `EnvironmentsOps.openImage(key, path)` answers: the
 * path rules (`checkSegments`: relative segments, never `..` or `.git`),
 * then the file must be a regular file inside the worktree reached without
 * a symlink (`openWorkspaceFile` of `./git.js`), then the source. The
 * source holds no descriptor and no table entry: its closure keeps the key
 * and the segments, and every `size()` and `readBase64` opens, checks and
 * reads the file again, so a file changed between reads is read as it is
 * now and a symlink swapped in is refused (`gitPathRefused`). After the
 * key is withdrawn (emergency stop) or released every call is refused; a
 * new adapter incarnation makes it a tombstone.
 *
 * Pages: at most `imageLimits.readPageBytes` raw bytes whatever `maxBytes`
 * asks (the guard's page bound); `done` when the page reaches the file's
 * current end.
 *
 * Node only (adapter); no state.
 */

import { Buffer } from 'node:buffer';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import {
  environmentTexts,
  environmentShapes,
} from '../../../guest/lib/guards/environments.js';
import { imageLimits } from '../../../guest/lib/limits.js';
import {
  imageInterfaceBuilders,
  imageShapeBuilders,
  imageTexts,
} from '../../../guest/lib/interfaces.js';
import {
  lazyTable,
  shapes as baseShapes,
} from '../../../guest/lib/guards/base.js';
/* eslint-enable import/no-relative-packages */
import { checkSegments, openWorkspaceFile } from './git.js';

const { makeExo, mustMatch } = /** @type {any} */ (globalThis);

/**
 * M8's image shapes and the `ImageSource` guard, built on first use, over
 * the base table (`ToolOutcome`, `Id`).
 * @type {any}
 */
const imageTable = lazyTable(
  {
    ...imageShapeBuilders(() => imageTable),
    ...imageInterfaceBuilders(() => imageTable),
  },
  baseShapes,
);

/**
 * @typedef {object} ImageSourcePowers
 * @property {string} key the environment's key (adapter-internal)
 * @property {string[]} segments the checked path inside the worktree
 * @property {(key: string) => { workspace: string }} dirsOf
 * @property {(key: string) => boolean | string} isWithdrawn true (or the
 *   refusal text) when the key's adapter-side objects are refused: an
 *   emergency stop (`environmentTexts.stopped`) or a release
 */

/**
 * @param {ImageSourcePowers} powers
 */
const refusalOf = ({ key, isWithdrawn }) => {
  const withdrawn = isWithdrawn(key);
  if (withdrawn === false) return undefined;
  return typeof withdrawn === 'string' ? withdrawn : environmentTexts.stopped;
};

/**
 * Open the source's file, checked again (refusal first).
 * @param {ImageSourcePowers} powers
 */
const openChecked = async powers => {
  const refusal = refusalOf(powers);
  if (refusal !== undefined) throw Error(refusal);
  return openWorkspaceFile(
    powers.dirsOf(powers.key).workspace,
    powers.segments,
    imageTexts.notFound,
  );
};

/**
 * The adapter-side `ImageSource` over `(key, segments)`.
 * @param {ImageSourcePowers} powers
 */
export const makeImageSource = powers =>
  makeExo('ImageSource', imageTable.ImageSource, {
    async size() {
      const { handle, size } = await openChecked(powers);
      await handle.close();
      return size;
    },
    /** @param {{ offset: number, maxBytes: number }} range */
    async readBase64({ offset, maxBytes }) {
      const { handle, size } = await openChecked(powers);
      try {
        const start = Math.min(Math.floor(offset), size);
        const want = Math.min(
          Math.floor(maxBytes),
          imageLimits.readPageBytes,
          size - start,
        );
        const buffer = Buffer.alloc(want);
        let read = 0;
        while (read < want) {
          // eslint-disable-next-line no-await-in-loop
          const { bytesRead } = await handle.read(
            buffer,
            read,
            want - read,
            start + read,
          );
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return harden({
          data: buffer.subarray(0, read).toString('base64'),
          done: start + read >= size,
        });
      } finally {
        await handle.close();
      }
    },
  });
harden(makeImageSource);

/**
 * `EnvironmentsOps.openImage(key, path)`: check the path and the file,
 * then answer the source. Rejects with `gitPathRefused` (a path outside
 * the rules, a symlink, a directory, a FIFO or other non-regular file),
 * `imageTexts.notFound` (nothing there) or the withdrawn refusal.
 * @param {Omit<ImageSourcePowers, 'segments'> & { segments: unknown }} powers
 */
export const openImage = async ({ key, segments, dirsOf, isWithdrawn }) => {
  mustMatch(harden(segments), environmentShapes.ImagePath, 'openImage path');
  const checked = harden([
    ...checkSegments(segments, imageLimits.pathSegments),
  ]);
  const powers = harden({ key, segments: checked, dirsOf, isWithdrawn });
  const { handle } = await openChecked(powers);
  await handle.close();
  return makeImageSource(powers);
};
harden(openImage);
