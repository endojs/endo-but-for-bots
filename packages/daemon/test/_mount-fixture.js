// @ts-check

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Buffer } from 'node:buffer';

const manifestUrl = new URL('./mount-fixture-manifest.json', import.meta.url);

/**
 * @typedef {object} FixtureRecord
 * @property {string} path
 * @property {'file' | 'directory' | 'symlink'} type
 * @property {string} [content]
 * @property {'base64'} [encoding]
 * @property {string} [target]
 * @property {boolean} [optional]
 */

/**
 * Load the shared, cross-language mount fixture manifest.
 *
 * @returns {{ description: string, entries: FixtureRecord[] }}
 */
export const loadMountFixtureManifest = () =>
  JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
harden(loadMountFixtureManifest);

/**
 * Materialize the shared mount fixture manifest into a fresh temp directory
 * and return the mount root path. The mount root is a `root/` subdirectory of
 * a private parent temp dir, so the manifest's escaping symlink
 * (`escape -> ../escape-target`) resolves to a sibling *outside* the mount
 * root, exercising confinement.
 *
 * Records flagged `optional: true` (the symlink) are skipped when the platform
 * cannot create them; the returned `created` / `skipped` sets let a case-table
 * runner gate expectations that depend on the optional entries.
 *
 * @param {import('ava').ExecutionContext} t
 * @returns {{ root: string, created: Set<string>, skipped: Set<string> }}
 */
export const buildMountFixture = t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-fixture-'));
  t.teardown(() => fs.rmSync(parent, { recursive: true, force: true }));

  const root = path.join(parent, 'root');
  fs.mkdirSync(root);

  // The manifest's escaping symlink points here, one level above the mount
  // root, so a correct glob/list excludes it.
  const escapeTarget = path.join(parent, 'escape-target');
  fs.mkdirSync(escapeTarget);
  fs.writeFileSync(
    path.join(escapeTarget, 'secret.txt'),
    'outside the mount\n',
  );

  const { entries } = loadMountFixtureManifest();
  /** @type {Set<string>} */
  const created = new Set();
  /** @type {Set<string>} */
  const skipped = new Set();

  for (const record of entries) {
    const dest = path.join(root, record.path);
    if (record.type === 'directory') {
      fs.mkdirSync(dest, { recursive: true });
    } else if (record.type === 'file') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const body =
        record.encoding === 'base64'
          ? Buffer.from(record.content ?? '', 'base64')
          : (record.content ?? '');
      fs.writeFileSync(dest, body);
    } else if (record.type === 'symlink') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.symlinkSync(/** @type {string} */ (record.target), dest);
        created.add(record.path);
      } catch (error) {
        if (record.optional) {
          skipped.add(record.path);
        } else {
          throw error;
        }
      }
    } else {
      throw new Error(`Unknown fixture record type: ${record.type}`);
    }
  }

  return { root, created, skipped };
};
harden(buildMountFixture);
