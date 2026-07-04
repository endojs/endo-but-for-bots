// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/far';
import { MgmtView } from '@endo/space-endo-mgmt';

import { h, renderConfined, unmount } from './setup-preact-container.js';

/**
 * Mount the hosted-Endo management UI, replacing the parent content. Resolves
 * powers from the profilePath (normally empty → the host/AGENT powers) and
 * renders the `@endo/space-endo-mgmt` package's pure `MgmtView` through the
 * project's CONFINED renderer, so the whole tree is sanitized exactly like
 * every other surface in the app.
 *
 * @param {HTMLElement} $parent
 * @param {unknown} rootPowers
 * @param {string[]} profilePath
 * @param {(newPath: string[]) => void} _onProfileChange
 * @returns {() => void} cleanup function
 */
export const managementComponent = (
  $parent,
  rootPowers,
  profilePath,
  _onProfileChange,
) => {
  $parent.replaceChildren();

  /** @type {unknown} */
  let resolvedPowers = rootPowers;
  for (const name of profilePath) {
    resolvedPowers = E(/** @type {any} */ (resolvedPowers)).lookup(name);
  }

  const $mount = $parent.ownerDocument.createElement('div');
  $mount.id = 'management-root';
  $mount.style.width = '100%';
  $mount.style.height = '100%';
  $parent.appendChild($mount);

  renderConfined(h(MgmtView, { powers: resolvedPowers }), $mount);

  return () => {
    unmount($mount);
    $mount.remove();
  };
};
harden(managementComponent);
