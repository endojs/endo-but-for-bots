// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { makeFilePowers } from '../src/manager-node-powers.js';

/**
 * @param {import('ava').ExecutionContext} t
 */
const makeFixture = async t => {
  const root = await fs.promises.mkdtemp(
    path.join(tmpdir(), 'rename-no-replace-'),
  );
  t.teardown(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePowers = makeFilePowers({ fs, path });
  if (filePowers.renameNoReplace === undefined) {
    throw Error('the Node file powers provide renameNoReplace');
  }
  return { root, filePowers, renameNoReplace: filePowers.renameNoReplace };
};

test('renameNoReplace moves a file, a directory and a symlink, reporting the moved identity', async t => {
  const { root, filePowers, renameNoReplace } = await makeFixture(t);
  await fs.promises.writeFile(path.join(root, 'file'), 'file\n');
  await fs.promises.mkdir(path.join(root, 'directory'));
  await fs.promises.writeFile(path.join(root, 'directory', 'inner'), 'in\n');
  await fs.promises.symlink('/nonexistent', path.join(root, 'link'));

  for (const name of ['file', 'directory', 'link']) {
    const source = path.join(root, name);
    const target = path.join(root, `${name}-moved`);
    // eslint-disable-next-line no-await-in-loop
    const identity = await filePowers.entryIdentity(source);
    // eslint-disable-next-line no-await-in-loop
    const movedIdentity = await renameNoReplace(source, target);
    // eslint-disable-next-line no-await-in-loop
    t.is(await filePowers.entryIdentity(target), movedIdentity, name);
    if (name !== 'link') {
      // A symbolic link is recreated; anything else keeps its identity.
      t.is(movedIdentity, identity, name);
    }
    t.false(fs.existsSync(source), name);
  }
  t.is(
    await fs.promises.readFile(
      path.join(root, 'directory-moved', 'inner'),
      'utf8',
    ),
    'in\n',
  );
  t.is(
    await fs.promises.readlink(path.join(root, 'link-moved')),
    '/nonexistent',
  );
});

test('renameNoReplace refuses every existing target and leaves it intact', async t => {
  const { root, renameNoReplace } = await makeFixture(t);
  await fs.promises.writeFile(path.join(root, 'file'), 'source\n');
  await fs.promises.mkdir(path.join(root, 'directory'));
  await fs.promises.symlink('/nonexistent', path.join(root, 'link'));
  await fs.promises.writeFile(path.join(root, 'occupied-file'), 'keep\n');
  await fs.promises.mkdir(path.join(root, 'empty-directory'));

  for (const source of ['file', 'directory', 'link']) {
    for (const target of ['occupied-file', 'empty-directory']) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(
        renameNoReplace(path.join(root, source), path.join(root, target)),
        { code: 'EEXIST' },
        `${source} onto ${target}`,
      );
    }
  }
  t.is(
    await fs.promises.readFile(path.join(root, 'occupied-file'), 'utf8'),
    'keep\n',
  );
  t.deepEqual(
    await fs.promises.readdir(path.join(root, 'empty-directory')),
    [],
  );
  t.is(await fs.promises.readFile(path.join(root, 'file'), 'utf8'), 'source\n');
  t.true(fs.existsSync(path.join(root, 'directory')));
  t.is(await fs.promises.readlink(path.join(root, 'link')), '/nonexistent');
});

test('removeEmptyDirectory refuses a directory with content', async t => {
  const { root, filePowers } = await makeFixture(t);
  await fs.promises.mkdir(path.join(root, 'full'));
  await fs.promises.writeFile(path.join(root, 'full', 'keep'), 'keep\n');
  await t.throwsAsync(filePowers.removeEmptyDirectory(path.join(root, 'full')));
  t.is(
    await fs.promises.readFile(path.join(root, 'full', 'keep'), 'utf8'),
    'keep\n',
  );
  await fs.promises.mkdir(path.join(root, 'empty'));
  await filePowers.removeEmptyDirectory(path.join(root, 'empty'));
  t.false(fs.existsSync(path.join(root, 'empty')));
});
