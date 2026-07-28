// @ts-check

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reroute a release-pinned module URL through a hosted deploy's stable
 * `current` symlink so a pinned UNCONFINED formula survives release pruning.
 *
 * The daemon stores a `make-unconfined` formula's specifier *verbatim* and
 * re-`import()`s it unchanged on every revival; it never canonicalizes the
 * path. A release directory leaks into the stored specifier because
 * `import.meta.url` is already symlink-resolved by Node to
 * `<stateDir>/releases/<id>/…`, so a caplet minted from it pins that one
 * release. A deploy that keeps only the newest few releases eventually prunes
 * the pinning release, after which the stored path dangles
 * (`Cannot find module …/releases/<old>/…`) — e.g. an iroh transport installed
 * under `@nets/iroh` fails to revive on the next restart.
 *
 * When the deploy also maintains `<stateDir>/current` → the live release,
 * rewriting `…/releases/<id>/…` to `…/current/…` makes the stored specifier
 * re-resolve to whatever release is live at revival time.
 *
 * No-op outside that layout: a URL with no `releases/<id>/` segment, or one
 * whose `current` twin does not resolve on disk (a dev checkout, or a deploy
 * with no symlink), is returned unchanged. (This helper is a daemon-local twin
 * of the one in `@endo/claude-sandbox`; the daemon may not depend on that
 * package, so the small pure function is duplicated rather than shared.)
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
