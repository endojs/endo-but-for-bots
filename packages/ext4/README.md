# @endo/ext4

A **read-only, lazy ext2/3/4 filesystem reader** that presents a block device's
filesystem as an **Endo fs object** — a `ReadableTree` of directories and
`ReadableBlob` files, the same shape `@endo/platform`'s filesystem caps and the
`@endo/daemon` consume.

This is the top of a composable stack:

```
raw device  →  @endo/block-device   (load the bytes)
            →  @endo/luks            (decrypt LUKS2 on read)
            →  @endo/ext4            (read the filesystem)
            →  an Endo fs object     (ReadableTree / ReadableBlob)
```

## Usage

```js
import { E } from '@endo/eventual-send';
import { makeFileBlockDevice } from '@endo/block-device/node.js';
import { openLuksDevice } from '@endo/luks';
import { makeExt4Filesystem } from '@endo/ext4';

const raw = await makeFileBlockDevice('/dev/rdisk4', { size });
const decrypted = await openLuksDevice(raw, passphrase);
const fs = await makeExt4Filesystem(decrypted);

await E(fs).list(); // [ 'lost+found', 'photos', 'notes.txt', ... ]
await E(fs).has('photos', 'trip.jpg'); // true

const notes = await E(fs).lookup('notes.txt');
await E(notes).text(); // whole-file UTF-8

const photo = await E(fs).lookup('photos/trip.jpg');
await E(photo).fetch(0n, 65_536n); // a windowed read — lazy!
```

Reading a plain (unencrypted) ext4 image needs no LUKS layer — hand
`makeExt4Filesystem` any `BlockDevice`.

## The fs object

`makeExt4Filesystem` returns a directory exo implementing the `ReadableTree`
surface:

- `has(...path)` — does the path exist?
- `list(...path)` — child names of a directory.
- `lookup(name | path)` — a child `ReadableTree` (subdirectory) or
  `ReadableBlob` (file).

Files implement the `ReadableBlob` range-read surface:

- `fetch(offset, length)` — a **windowed read**, the lazy primitive.
- `text()` / `json()` / `streamBase64(writer)` — whole-file accessors.
- `getInfo()` — `{ algorithm, hash, size }`.

`fetch` reads only the filesystem blocks the window touches, which under
`@endo/luks` decrypts only the sectors those blocks occupy, which reads only
those bytes from the raw device. Laziness composes all the way down.

## What it reads

- ext4 with **extent trees** and **64-bit** group descriptors (the modern
  `mke2fs` default), and classic ext2/3 with **indirect block maps** and 32-bit
  descriptors.
- Block sizes from 1 KiB to 64 KiB, inode sizes of 128 bytes and up.
- Directories (including hashed `dir_index` directories — read linearly),
  regular files, and symbolic links. Sparse holes read as zeros.

It does not interpret journals (a cleanly-unmounted volume needs none),
verify `metadata_csum` checksums, or support inline-data inodes. It never
writes.
