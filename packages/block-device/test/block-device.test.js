import test from '@endo/ses-ava/test.js';

import {
  makeMemoryBlockDevice,
  makeSlicedBlockDevice,
  makeCachingBlockDevice,
} from '../index.js';

/** @param {number} n */
const ramp = n => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    bytes[i] = i % 256;
  }
  return bytes;
};

test('memory device reads exact ranges', async t => {
  const device = makeMemoryBlockDevice(ramp(256));
  t.is(await device.getSize(), 256);
  t.deepEqual(await device.read(0, 4), new Uint8Array([0, 1, 2, 3]));
  t.deepEqual(await device.read(10, 3), new Uint8Array([10, 11, 12]));
  t.deepEqual(await device.read(256, 0), new Uint8Array([]));
});

test('memory device rejects out-of-range reads', async t => {
  const device = makeMemoryBlockDevice(ramp(16));
  await t.throwsAsync(() => device.read(10, 10), {
    message: /exceeds device size/,
  });
  await t.throwsAsync(() => device.read(-1, 1), {
    message: /non-negative integer/,
  });
});

test('memory device returns fresh copies', async t => {
  const backing = ramp(16);
  const device = makeMemoryBlockDevice(backing);
  const first = await device.read(0, 8);
  first[0] = 0xff;
  const second = await device.read(0, 8);
  t.is(second[0], 0, 'mutation of a read does not affect the backing store');
});

test('sliced device translates offsets', async t => {
  const device = makeMemoryBlockDevice(ramp(256));
  const slice = makeSlicedBlockDevice(device, 64, 32);
  t.is(await slice.getSize(), 32);
  t.deepEqual(await slice.read(0, 4), new Uint8Array([64, 65, 66, 67]));
  t.deepEqual(await slice.read(28, 4), new Uint8Array([92, 93, 94, 95]));
  await t.throwsAsync(() => slice.read(30, 4), {
    message: /exceeds device size/,
  });
});

test('sliced device defaults to remainder of parent', async t => {
  const device = makeMemoryBlockDevice(ramp(100));
  const slice = makeSlicedBlockDevice(device, 40);
  t.is(await slice.getSize(), 60);
  t.deepEqual(await slice.read(0, 2), new Uint8Array([40, 41]));
});

test('caching device matches underlying and coalesces reads', async t => {
  const backing = ramp(4096);
  const inner = makeMemoryBlockDevice(backing, { sectorSize: 512 });
  let reads = 0;
  const counting = harden({
    sectorSize: 512,
    getSize: () => inner.getSize(),
    read: (offset, length) => {
      reads += 1;
      return inner.read(offset, length);
    },
  });
  const cached = makeCachingBlockDevice(counting, {
    pageSize: 1024,
    maxPages: 8,
  });

  // Several reads within the same 1 KiB page should fault the page in once.
  t.deepEqual(await cached.read(0, 16), backing.slice(0, 16));
  t.deepEqual(await cached.read(100, 16), backing.slice(100, 116));
  t.deepEqual(await cached.read(1000, 16), backing.slice(1000, 1016));
  t.is(reads, 1, 'all three reads fall within page 0 (bytes 0..1024)');

  // A read crossing a page boundary assembles two newly-faulted pages.
  const crossing = await cached.read(2040, 16);
  t.deepEqual(crossing, backing.slice(2040, 2056));
  t.is(reads, 3, 'pages 1 (1024..2048) and 2 (2048..3072) faulted in');
});

test('caching device handles a partial tail page', async t => {
  const backing = ramp(1500);
  const inner = makeMemoryBlockDevice(backing, { sectorSize: 512 });
  const cached = makeCachingBlockDevice(inner, { pageSize: 1024 });
  t.deepEqual(await cached.read(1400, 100), backing.slice(1400, 1500));
  await t.throwsAsync(() => cached.read(1490, 20), {
    message: /exceeds device size/,
  });
});
