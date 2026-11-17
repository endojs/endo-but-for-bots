// @ts-check

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Fail, q } from '@endo/errors';

/**
 * Reroute a release-pinned module URL through the hosted deploy's stable
 * `current` symlink so a pinned UNCONFINED formula survives release pruning.
 *
 * The daemon stores a `make-unconfined` formula's specifier *verbatim* (see
 * daemon `formula-record.js` — `{ kind: 'literal', value: specifier }`) and
 * re-`import()`s it unchanged on every revival (`worker.js`). It never
 * canonicalizes the path. The release directory only leaks in because
 * `import.meta.url` is already symlink-resolved by Node to
 * `<stateDir>/releases/<id>/…`, so a caplet minted from it pins that one
 * release. The deploy keeps only the newest few releases, so once the pinning
 * release is pruned the stored path dangles:
 * `Cannot find module …/releases/<old>/…`.
 *
 * The deploy also maintains `<stateDir>/current` → the live release. Rewriting
 * `…/releases/<id>/…` to `…/current/…` makes the stored specifier re-resolve to
 * whatever release is live at revival time. Crucially this fixes not just
 * setup-time caplets but the per-session caps minted at runtime (the client
 * and session filesystem modules) — those are created long after setup, so a
 * setup-time "re-bind to current" cannot reach them.
 *
 * No-op outside that layout: a URL with no `releases/<id>/` segment, or one
 * whose `current` twin does not resolve on disk (a dev checkout, or a deploy
 * with no symlink), is returned unchanged.
 *
 * @param {string} specifier - a `file:` module URL (typically from a
 *   `new URL(relative, import.meta.url).href` computation)
 * @returns {string}
 */
export const toCurrentSpecifier = specifier => {
  const match = /^(.*)\/releases\/[^/]+\/(.*)$/.exec(specifier);
  if (!match) {
    return specifier;
  }
  const [, stateRoot, rest] = match;
  const currentSpecifier = `${stateRoot}/current/${rest}`;
  try {
    // existsSync follows the `current` symlink, so a truthy result means the
    // module is actually reachable through it — only then is the rewrite safe.
    if (existsSync(fileURLToPath(currentSpecifier))) {
      return currentSpecifier;
    }
  } catch {
    // Unparseable URL or unreadable path: keep the concrete release specifier.
  }
  return specifier;
};
harden(toCurrentSpecifier);

/**
 * Fail closed when a specifier that must survive release pruning still points
 * at a concrete release. `toCurrentSpecifier` rewrites `releases/<id>/` paths
 * through `<stateDir>/current` when that twin resolves; if it could not (no
 * symlink, unreadable path) the formula would be minted with a path that
 * dangles as soon as the release is pruned, so setup must abort instead of
 * committing a poisoned binding (DESIGN § Credential path).
 *
 * @param {string} specifier
 * @param {string} label
 * @returns {string}
 */
export const assertCurrentSpecifier = (specifier, label = 'module') => {
  if (/\/releases\/[^/]+\//.test(specifier)) {
    Fail`${q(label)} module specifier ${q(specifier)} is pinned to a concrete release; expected it to resolve through <stateDir>/current for revival`;
  }
  return specifier;
};
harden(assertCurrentSpecifier);
