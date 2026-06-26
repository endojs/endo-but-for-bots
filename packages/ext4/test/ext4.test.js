import test from '@endo/ses-ava/test.js';
import { E } from '@endo/eventual-send';

import { makeFileBlockDevice } from '@endo/block-device/node.js';

import { makeExt4Filesystem } from '../src/fs-object.js';
import { makeExt4Reader } from '../src/reader.js';
import { haveTools, buildExt4Image } from './_tools.js';

const itExt4 = haveTools('mke2fs', 'truncate') ? test : test.skip;

// A multi-block file (~30 KiB) to exercise extent / indirect block walking.
const bigText = Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join('');

const sampleFiles = {
  'hello.txt': 'hello from luks endo fs\n',
  'sub/nested.txt': 'nested file content here\n',
  'big.txt': bigText,
};

const openFs = async (t, options) => {
  const image = buildExt4Image({ files: sampleFiles, ...options });
  t.teardown(image.cleanup);
  const device = await makeFileBlockDevice(image.imgPath, {
    size: image.sizeBytes,
    sectorSize: 512,
  });
  t.teardown(() => device.close());
  return makeExt4Filesystem(device);
};

for (const { label, options } of [
  { label: 'extent + 64bit (modern default)', options: {} },
  {
    label: 'indirect block map + 32bit descriptors',
    options: { features: ['^extent', '^64bit'] },
  },
]) {
  itExt4(`reads files and directories: ${label}`, async t => {
    const fs = await openFs(t, options);

    const names = await E(fs).list();
    t.true(names.includes('hello.txt'));
    t.true(names.includes('sub'));
    t.true(names.includes('big.txt'));
    t.false(names.includes('.'), 'self/parent links are filtered out');

    const hello = await E(fs).lookup('hello.txt');
    t.is(await E(hello).text(), sampleFiles['hello.txt']);

    // Nested directory traversal, both as a path string and via subtree.
    t.is(
      await E(await E(fs).lookup('sub/nested.txt')).text(),
      sampleFiles['sub/nested.txt'],
    );
    const sub = await E(fs).lookup('sub');
    t.deepEqual(await E(sub).list(), ['nested.txt']);
    t.is(
      await E(await E(sub).lookup('nested.txt')).text(),
      sampleFiles['sub/nested.txt'],
    );

    // Multi-block file read in full.
    const big = await E(fs).lookup('big.txt');
    t.is(await E(big).text(), bigText);

    // has() / missing path behavior.
    t.true(await E(fs).has('sub', 'nested.txt'));
    t.false(await E(fs).has('nope'));
    await t.throwsAsync(() => E(fs).lookup('nope'), {
      message: /No such path/,
    });
  });
}

itExt4('fetch() reads exact byte windows lazily', async t => {
  const fs = await openFs(t, {});
  const big = await E(fs).lookup('big.txt');

  const info = await E(big).getInfo();
  t.is(info.size, bigText.length);
  t.is(info.algorithm, 'sha256');

  const encoder = new TextEncoder();
  const whole = encoder.encode(bigText);

  // A window straddling several filesystem blocks.
  const window = await E(big).fetch(5000n, 4096n);
  t.deepEqual(new Uint8Array(window), whole.subarray(5000, 5000 + 4096));

  // A window at the very end clamps to EOF.
  const tail = await E(big).fetch(BigInt(whole.length - 10), 100n);
  t.deepEqual(new Uint8Array(tail), whole.subarray(whole.length - 10));
});

itExt4('low-level reader resolves paths and inode types', async t => {
  const image = buildExt4Image({ files: sampleFiles });
  t.teardown(image.cleanup);
  const device = await makeFileBlockDevice(image.imgPath, {
    size: image.sizeBytes,
    sectorSize: 512,
  });
  t.teardown(() => device.close());

  const reader = await makeExt4Reader(device);
  t.is(reader.superblock.blockSize, 4096);
  t.true(reader.root.isDirectory);

  const helloInode = await reader.resolve('hello.txt');
  t.true(helloInode.isFile);
  t.is(helloInode.size, sampleFiles['hello.txt'].length);

  const missing = await reader.maybeResolve('does/not/exist');
  t.is(missing, undefined);
});
