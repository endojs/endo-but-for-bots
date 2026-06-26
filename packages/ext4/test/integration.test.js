import test from '@endo/ses-ava/test.js';
import { E } from '@endo/eventual-send';

import { makeFileBlockDevice } from '@endo/block-device/node.js';
import { makeCachingBlockDevice } from '@endo/block-device';
import { openLuksDevice } from '@endo/luks';

import { makeExt4Filesystem } from '../src/fs-object.js';
import { haveTools, buildLuksVolume } from './_tools.js';

const itChain = haveTools('cryptsetup', 'mke2fs', 'truncate')
  ? test
  : test.skip;

const bigText = Array.from({ length: 2000 }, (_, i) => `record ${i}\n`).join(
  '',
);

itChain(
  'reads files through raw device -> LUKS -> ext4 -> fs object',
  async t => {
    const volume = buildLuksVolume({
      withFilesystem: true,
      files: {
        'readme.md': '# top secret\n',
        'dir/data.json': JSON.stringify({ answer: 42, nested: [1, 2, 3] }),
        'dir/deep/leaf.txt': 'a leaf far down the tree\n',
        'big.bin': bigText,
      },
    });
    t.teardown(volume.cleanup);

    // Bottom of the stack: the raw container file as a block device.
    const base = await makeFileBlockDevice(volume.imgPath, {
      size: volume.sizeBytes,
      sectorSize: 512,
    });
    t.teardown(() => base.close());

    // Middle: a decrypt-on-read block device over the LUKS data segment,
    // wrapped in a page cache (proving the layers compose).
    const decrypted = await openLuksDevice(base, volume.passphrase);
    const cached = makeCachingBlockDevice(decrypted, { pageSize: 65_536 });

    // Top: the ext4 filesystem as an Endo ReadableTree.
    const fs = await makeExt4Filesystem(cached);

    const rootNames = await E(fs).list();
    for (const name of ['big.bin', 'dir', 'readme.md']) {
      t.true(rootNames.includes(name), `root contains ${name}`);
    }

    t.is(await E(await E(fs).lookup('readme.md')).text(), '# top secret\n');
    t.deepEqual(await E(await E(fs).lookup('dir/data.json')).json(), {
      answer: 42,
      nested: [1, 2, 3],
    });
    t.is(
      await E(await E(fs).lookup(['dir', 'deep', 'leaf.txt'])).text(),
      'a leaf far down the tree\n',
    );

    // The big file round-trips, and a windowed fetch returns exact bytes —
    // lazily, faulting only the touched ext4 blocks and LUKS sectors.
    const big = await E(fs).lookup('big.bin');
    t.is(await E(big).text(), bigText);
    const whole = new TextEncoder().encode(bigText);
    const window = await E(big).fetch(10_000n, 2048n);
    t.deepEqual(new Uint8Array(window), whole.subarray(10_000, 10_000 + 2048));
  },
);

itChain('a wrong passphrase fails to open the volume', async t => {
  const volume = buildLuksVolume({ withFilesystem: true });
  t.teardown(volume.cleanup);
  const base = await makeFileBlockDevice(volume.imgPath, {
    size: volume.sizeBytes,
    sectorSize: 512,
  });
  t.teardown(() => base.close());
  await t.throwsAsync(() => openLuksDevice(base, 'wrong-passphrase'), {
    message: /No keyslot could be unlocked/,
  });
});
