# @endo/block-device

A small, portable abstraction for a **lazily-readable, byte-addressable block
device**: a raw disk, a partition, a disk image, an in-memory buffer, or a
decrypting view layered over another device.

It is the bottom of a composable storage stack.
`@endo/luks` layers LUKS2 decryption over a block device to produce another
block device; `@endo/ext4` reads a filesystem out of a block device and
presents it as an Endo fs object.
Each layer only ever reads the bytes it is asked for, so the whole stack stays
lazy from a filesystem lookup all the way down to the raw device.

## The interface

```js
/**
 * @typedef {object} BlockDevice
 * @property {() => Promise<number>} getSize       Total size in bytes.
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {number} sectorSize                   Read-alignment hint.
 */
```

`read` returns a fresh `Uint8Array` of exactly the requested length, and never
reads past the end of the device — an out-of-range read is an error, not a
short read, so a caller never mistakes uninitialized bytes for data.

## Implementations

```js
import {
  makeMemoryBlockDevice,
  makeSlicedBlockDevice,
  makeCachingBlockDevice,
} from '@endo/block-device';
import { makeFileBlockDevice } from '@endo/block-device/node.js';

// Wrap bytes already in memory (useful for tests).
const mem = makeMemoryBlockDevice(someUint8Array);

// A contiguous sub-range view — e.g. a partition or a LUKS data segment.
const partition = makeSlicedBlockDevice(mem, 1024 * 1024);

// A page cache so repeated metadata reads do not re-hit (or re-decrypt) the
// underlying device.
const cached = makeCachingBlockDevice(partition, { pageSize: 65_536 });

// A Node-backed device over a file, disk image, or raw device node.
const disk = await makeFileBlockDevice('/dev/rdisk4', { size: 64 * 2 ** 30 });
```

### Reading a raw disk on macOS

Point `makeFileBlockDevice` at the **raw** device node (`/dev/rdiskN`, not
`/dev/diskN`) for unbuffered access:

```sh
diskutil list                 # find the disk, e.g. /dev/disk4
diskutil unmountDisk /dev/disk4
```

```js
const disk = await makeFileBlockDevice('/dev/rdisk4', { size });
```

Raw device nodes report a `stat` size of `0`, so you must pass an explicit
`size` (read it from `diskutil info`). Reading a raw device generally requires
elevated privileges.

`makeFileBlockDevice` resolves to a `BlockDevice` with an extra `close()`
method; call it when you are done.
