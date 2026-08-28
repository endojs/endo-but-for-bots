import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import test from 'ava';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('eval twins share the first shim installation', async t => {
  const temporaryRoot = await mkdtemp(join(packageRoot, '.eval-twin-'));
  const firstPath = join(temporaryRoot, 'first');
  const secondPath = join(temporaryRoot, 'second');
  await symlink(packageRoot, firstPath, 'dir');
  await symlink(packageRoot, secondPath, 'dir');

  const firstUrl = pathToFileURL(join(firstPath, 'index.js')).href;
  const secondUrl = pathToFileURL(join(secondPath, 'index.js')).href;
  const source = `
    const first = await import(${JSON.stringify(firstUrl)});
    const firstBytes = first.frozenBytes(new Uint8Array([1, 2, 3]));
    if (ArrayBuffer.isView(firstBytes)) throw Error('first copy did not emulate');

    const second = await import(${JSON.stringify(secondUrl)});
    const secondBytes = second.frozenBytes(new Uint8Array([4, 5, 6]));
    if (ArrayBuffer.isView(secondBytes)) throw Error('second copy escaped winner');
    const thawed = second.thawedBytes(secondBytes);
    if (String([...thawed]) !== '4,5,6') throw Error('eval twin corrupted bytes');
  `;

  try {
    const result = await execFileAsync(process.execPath, [
      '--preserve-symlinks',
      '--input-type=module',
      '--eval',
      source,
    ]);
    t.is(result.stderr, '');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
