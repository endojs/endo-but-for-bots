// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeNodeScratchDirectoryMaker } from '../src/scratch-directory.js';

/**
 * @param {{ mode: number }} status
 */
const permissions = ({ mode }) => mode.toString(8).slice(-3);

test('a scratch directory holds private files and is removed', async t => {
  const parentDirectory = await mkdtemp(join(tmpdir(), 'endo-claude-test-'));
  t.teardown(() => rm(parentDirectory, { recursive: true, force: true }));
  const makeScratchDirectory = makeNodeScratchDirectoryMaker({
    parentDirectory,
  });

  const scratch = await makeScratchDirectory();
  t.deepEqual(await readdir(scratch.configDirectory), []);
  t.is(permissions(await stat(scratch.configDirectory)), '700');

  const filePath = await scratch.writeFile('settings.json', '{}');
  t.is(await readFile(filePath, 'utf8'), '{}');
  t.is(permissions(await stat(filePath)), '600');
  await t.throwsAsync(() => scratch.writeFile('settings.json', '{}'));
  await t.throwsAsync(() => scratch.writeFile('../escape.json', '{}'));

  await scratch.remove();
  t.deepEqual(await readdir(parentDirectory), []);
});
