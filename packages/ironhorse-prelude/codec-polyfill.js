// @ts-check

/**
 * The codec section of the daemon's `polyfills.js`, for the two build scripts
 * that prepend it to an Ironhorse boot.
 *
 * **Build-time only.** Unlike `./prelude.js`, which is bundled and evaluated in
 * the guest, this module reads the filesystem and runs in the builder. It is a
 * separate entry point for that reason: nothing here may be reachable from the
 * bundle, and `prelude.js` must never import it.
 *
 * Ironhorse has no host `TextEncoder`/`TextDecoder` -- node's prelude takes
 * them from `node:util`, and XS needs none -- so both
 * `@endo/thixotrope`'s `scripts/bundle-ironhorse-worker.mjs` and
 * `@endo/test262-runner`'s `scripts/generate-preludes.js` prepend this text.
 * They used to slice it independently, which is the same shape of duplication
 * the repairs in `./prelude.js` had before they were unified, and with the same
 * hazard: two copies of one magic comment, drifting silently.
 *
 * The file is not ours -- it belongs to `rust/endo/xsnap`, which embeds it for
 * XS -- so this is a read rather than a move.
 *
 * **Everything below the marker is deliberately excluded**, and the exclusion
 * is load-bearing rather than tidy:
 *
 * - the `assert` polyfill collides with test262's own `assert`;
 * - the `harden` section installs `Object[Symbol.for('harden')]`
 *   NON-configurably (`polyfills.js:248-251`), and that slot's mere presence
 *   makes SES's `repairIntrinsics` refuse -- "a prior harden implementation has
 *   been used and installed". `make-selector.js` installs it non-configurably,
 *   so a boot that lets it through cannot walk it back.
 */

import { readFileSync } from 'node:fs';

/**
 * The section marker `polyfills.js` carries for this purpose. Both consumers
 * used to spell it out; now one of them does.
 */
const ASSERT_SECTION = '// -- assert polyfill --';

/**
 * Read `polyfills.js` and return everything above the `assert` section.
 *
 * Throws rather than degrading if the marker is gone. `split(marker)[0]` on a
 * file without it returns the WHOLE file, so the previous form would have
 * quietly prepended the `harden` section to the boot and produced an Ironhorse
 * worker that cannot `lockdown()` -- a failure that surfaces as SES refusing
 * `repairIntrinsics` at boot, nowhere near the build script that caused it.
 *
 * @returns {string} the codec polyfills, verbatim.
 */
export const readCodecPolyfill = () => {
  const path = new URL(
    '../../rust/endo/xsnap/src/polyfills.js',
    import.meta.url,
  );
  const source = readFileSync(path, 'utf8');
  const marker = source.indexOf(ASSERT_SECTION);
  if (marker < 0) {
    throw Error(
      `${path.pathname}: no ${ASSERT_SECTION} marker. The Ironhorse boot slices there to exclude the assert and harden sections; without it the harden section would be prepended and lockdown() would refuse. Restore the marker, or teach @endo/ironhorse-prelude/codec-polyfill.js where the codec section now ends.`,
    );
  }
  return source.slice(0, marker);
};
