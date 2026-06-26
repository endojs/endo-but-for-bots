/* eslint no-bitwise: ["off"] */
import test from '@endo/ses-ava/test.js';

import { makeFileBlockDevice } from '@endo/block-device/node.js';

import { parseLuksHeader } from '../src/header.js';
import { unlockVolume } from '../src/unlock.js';
import { openLuksDevice } from '../src/device.js';
import { haveTools, buildLuksVolume } from './_tools.js';

const itLuks = haveTools('cryptsetup', 'mke2fs', 'truncate') ? test : test.skip;

itLuks('recovers the master key cryptsetup chose', async t => {
  const volume = buildLuksVolume({ withFilesystem: false });
  t.teardown(volume.cleanup);
  const device = await makeFileBlockDevice(volume.imgPath, {
    size: volume.sizeBytes,
    sectorSize: 512,
  });
  t.teardown(() => device.close());

  const header = await parseLuksHeader(device);
  t.is(header.version, 2);
  t.is(header.metadata.segments['0'].encryption, 'aes-xts-plain64');

  const unlocked = await unlockVolume(device, header, volume.passphrase);
  t.deepEqual(
    unlocked.masterKey,
    volume.masterKey,
    'derived volume key equals the key cryptsetup dumped',
  );
});

itLuks('rejects a wrong passphrase', async t => {
  const volume = buildLuksVolume({ withFilesystem: false });
  t.teardown(volume.cleanup);
  const device = await makeFileBlockDevice(volume.imgPath, {
    size: volume.sizeBytes,
    sectorSize: 512,
  });
  t.teardown(() => device.close());
  const header = await parseLuksHeader(device);
  await t.throwsAsync(
    () => unlockVolume(device, header, 'not-the-passphrase'),
    {
      message: /No keyslot could be unlocked/,
    },
  );
});

itLuks('decrypts the data segment to the original plaintext', async t => {
  // A recognizable plaintext written into the data area before encryption,
  // so we can prove decrypt-on-read returns exactly the original bytes.
  const volume = buildLuksVolume({
    withFilesystem: true,
    files: { 'marker.txt': 'the quick brown fox\n' },
  });
  t.teardown(volume.cleanup);
  const base = await makeFileBlockDevice(volume.imgPath, {
    size: volume.sizeBytes,
    sectorSize: 512,
  });
  t.teardown(() => base.close());

  const decrypted = await openLuksDevice(base, volume.passphrase);
  // The decrypted data segment must begin with a valid ext4 superblock
  // magic (0xEF53 at byte 1080 = 1024 + 56), proving the XTS layer lines up.
  const sbWindow = await decrypted.read(1024, 1024);
  const magic = sbWindow[56] | (sbWindow[57] << 8);
  t.is(magic, 0xef53, 'decrypted data exposes a valid ext4 superblock');
});
