// @ts-check
// The subscriptions manager as installed on a state provisioned at
// OLD_REVISION: that revision's `durable-subscriptions.js` and the copies
// of `guest/lib/**` it was bundled with, read with `git show` into
// `tmp/old-manager-<rev>/` (same layout, so its relative imports resolve
// to the old copies and its bare imports to this package's dependencies)
// and imported from there. A pinned vat keeps exactly this code: the
// tests run the current adapter and UI against it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** The revision the owner's state was provisioned at. */
export const OLD_REVISION = '51760a3996';

/** The old manager's module closure (its relative imports, transitively). */
const OLD_FILES = harden([
  'resources/agent-host/durable-subscriptions.js',
  'guest/lib/interfaces.js',
  'guest/lib/interfaces-m4.js',
  'guest/lib/subscription-limits.js',
  'guest/lib/subscription-texts.js',
  'guest/lib/limits.js',
  'guest/lib/bounded.js',
  'guest/lib/guards/base.js',
  'guest/lib/guards/session.js',
  'guest/lib/guards/factory.js',
  'guest/lib/guard-limits.js',
  'guest/lib/voice-preferences.js',
]);

/**
 * Import the old revision's `durable-subscriptions.js` (and its old
 * `subscription-texts.js`, for the texts it throws).
 * @returns {Promise<{ manager: any, texts: any }>}
 */
export const importOldManager = async () => {
  const root = join(harnessRoot, 'tmp', `old-manager-${OLD_REVISION}`);
  for (const file of OLD_FILES) {
    const text = execFileSync(
      'git',
      ['show', `${OLD_REVISION}:packages/thixotrope-harness/${file}`],
      { cwd: harnessRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const url = (/** @type {string} */ file) =>
    pathToFileURL(join(root, file)).href;
  const [manager, texts] = await Promise.all([
    import(url('resources/agent-host/durable-subscriptions.js')),
    import(url('guest/lib/subscription-texts.js')),
  ]);
  return { manager, texts };
};
