// @ts-check

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { WorkflowApp } from '@endo/space-workflow';

import { h, renderConfined, unmount } from './setup-preact-container.js';

/**
 * Mount the workflow space, replacing the parent content. Resolves
 * powers from the profilePath, looks up the workflow service capability
 * by pet-name path (default `workflow`), and renders the
 * `@endo/space-workflow` package's pure `WorkflowApp` through the
 * project's CONFINED renderer, so the whole tree is sanitized exactly
 * like every other surface in the app.
 *
 * The service is an ordinary capability in the agent's namespace — the
 * `@endo/workflow` plugin provisioned through the daemon's generic
 * `make-unconfined` pathway — so this bridge holds no workflow-specific
 * authority beyond that lookup.
 *
 * @param {HTMLElement} $parent
 * @param {unknown} rootPowers
 * @param {string[]} profilePath
 * @param {(newPath: string[]) => void} _onProfileChange
 * @param {string[]} [workflowPath] pet-name path to the workflow service
 * @returns {() => void} cleanup function
 */
export const workflowComponent = (
  $parent,
  rootPowers,
  profilePath,
  _onProfileChange,
  workflowPath = ['workflow'],
) => {
  $parent.replaceChildren();

  /** @type {unknown} */
  let resolvedPowers = rootPowers;
  for (const name of profilePath) {
    resolvedPowers = E(/** @type {any} */ (resolvedPowers)).lookup(name);
  }
  const service = E(/** @type {any} */ (resolvedPowers)).lookup(
    ...workflowPath,
  );

  // Dedicated mount child so teardown removes exactly what we added.
  const $mount = $parent.ownerDocument.createElement('div');
  $mount.id = 'workflow-root';
  $mount.style.width = '100%';
  $mount.style.height = '100%';
  $parent.appendChild($mount);

  renderConfined(h(WorkflowApp, { service }), $mount);

  return () => {
    // Unmount runs the component's useEffect teardown (stops the sync
    // client and releases the followRuns reader), then removes the
    // mount node from the DOM.
    unmount($mount);
    $mount.remove();
  };
};
harden(workflowComponent);
