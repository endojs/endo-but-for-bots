// @ts-check
import test from '@endo/ses-ava/test.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeNodePowers } from '../src/platform/node-powers.js';
import { makeFileSyncStringAtom } from '../src/store/file-sync-string-atom.js';

test('file string atom preserves raw contents across reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'thix-string-atom-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const powers = makeNodePowers();
  const path = join(directory, 'state');
  const atom = makeFileSyncStringAtom(powers, path);
  t.is(atom.read(), undefined);
  atom.write('');
  t.is(atom.read(), '');
  const text = 'not JSON: inventory\n雪\n';
  atom.write(text);
  t.is(await readFile(path, 'utf8'), text);
  t.is(makeFileSyncStringAtom(powers, path).read(), text);
});
