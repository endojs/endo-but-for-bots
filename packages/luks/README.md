# @endo/luks

Read **modern LUKS2** volumes — the on-disk format `cryptsetup` writes by
default — in portable JavaScript, with no kernel, no `dm-crypt`, and no native
dependencies.

This is the "decrypt" layer of a composable stack: given a `BlockDevice`
(`@endo/block-device`) holding a LUKS2 container and a passphrase, it returns
another `BlockDevice` that presents the **plaintext data segment**, decrypting
on read. Layer `@endo/ext4` on top to read the filesystem inside.

The original motivation: read a LUKS-encrypted USB drive on a **macOS** host,
which has no native LUKS support.

```js
import { makeFileBlockDevice } from '@endo/block-device/node.js';
import { openLuksDevice } from '@endo/luks';

const raw = await makeFileBlockDevice('/dev/rdisk4', { size });
const plaintext = await openLuksDevice(raw, 'correct horse battery staple');
// `plaintext` is a BlockDevice over the decrypted data segment.
const superblock = await plaintext.read(1024, 1024);
```

## What it supports

- **LUKS2** headers (binary header + JSON metadata).
- Key derivation with **Argon2id / Argon2i** (the modern default) and
  **PBKDF2** (SHA-256 / SHA-512).
- The **anti-forensic (AF) splitter** that protects keyslots.
- **`aes-xts-plain64`** for both the keyslot areas and the data segment — the
  cipher `cryptsetup` uses by default (AES-128 and AES-256 XTS).
- Multiple keyslots: `openLuksDevice` tries each in turn and accepts the first
  whose derived volume key satisfies the keyslot digest.

LUKS1 and ciphers other than `aes-xts-plain64` are out of scope.

## How decrypt-on-read stays lazy

`openLuksDevice` recovers the master key once, then returns a `BlockDevice`
whose `read(offset, length)` faults in only the ciphertext sectors covering
that window, decrypts them with AES-XTS, and returns the slice. Nothing but the
touched sectors is ever read or decrypted. Wrap it in
`makeCachingBlockDevice` to avoid re-decrypting hot metadata.

## Lower-level API

```js
import { parseLuksHeader, unlockVolume, makeXtsCodec, afMerge } from '@endo/luks';

const header = await parseLuksHeader(device);
const { masterKey, keyslotId, segment } = await unlockVolume(
  device,
  header,
  passphrase,
);
```

## Cryptography

The cryptographic primitives come from the audited, pure-JavaScript
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes) (Argon2, PBKDF2,
SHA-2) and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)
(AES). XTS sector tweaking and the GF(2^128) multiply are implemented here on
top of single-block AES.

> [!NOTE]
> Argon2 is memory-hard by design. A real volume's KDF parameters may request
> hundreds of megabytes to a gigabyte of memory per unlock attempt; that memory
> is allocated during `unlockVolume`. This is inherent to LUKS, not specific to
> this implementation.

> [!WARNING]
> This package decrypts; it never writes. It is intended for reading data off a
> volume you control. Handle recovered master keys and passphrases with care —
> they are ordinary `Uint8Array`s / strings in memory.
