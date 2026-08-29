// @ts-check
/* global process */

import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const CodexAuthSeederInterface = M.interface('CodexAuthSeeder', {
  seed: M.callWhen(M.string()).returns(M.record()),
  status: M.callWhen().returns(M.record()),
  help: M.call().returns(M.string()),
});

/**
 * @param {unknown} _powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string> }} [options]
 */
export const make = (_powers, _context, { env = {} } = {}) => {
  const codexHomeDir = env.CODEX_HOME_DIR || process.env.ENDO_CODEX_HOME;
  if (!codexHomeDir) throw new Error('CODEX_HOME_DIR is required.');
  const authPath = path.join(codexHomeDir, 'auth.json');

  return makeExo('CodexAuthSeeder', CodexAuthSeederInterface, {
    async seed(json) {
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error('Codex auth must be valid JSON.');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Codex auth must be a JSON object.');
      }
      let file;
      try {
        file = await open(authPath, 'wx', 0o600);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
          throw new Error(
            'Codex auth is already seeded; the refreshed on-disk file was left unchanged.',
          );
        }
        throw error;
      }
      try {
        await file.writeFile(json);
      } finally {
        await file.close();
      }
      return harden({
        kind: 'codexAuth',
        audience: 'codex-host',
        byteLength: new TextEncoder().encode(json).byteLength,
      });
    },
    async status() {
      try {
        const stat = await lstat(authPath);
        return harden({ seeded: stat.isFile(), byteLength: stat.size });
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          return harden({ seeded: false, byteLength: 0 });
        }
        throw error;
      }
    },
    help: () =>
      'CodexAuthSeeder: seed(authJson) writes auth.json once; status() returns metadata only.',
  });
};
harden(make);
