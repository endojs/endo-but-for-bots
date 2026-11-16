// @ts-check
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

export const harnessRoot = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
);

/**
 * A short private scratch directory under the package's git-ignored tmp/,
 * removed when the test ends.
 * @param {import('ava').ExecutionContext} t
 * @param {string} prefix at most a few characters
 */
export const scratch = async (t, prefix) => {
  const base = path.join(harnessRoot, 'tmp');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(base, prefix));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
