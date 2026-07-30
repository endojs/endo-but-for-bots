// Shared SHA-256 known-answer vectors, kept in one general fixture so every
// implementation path — the Node `node:crypto` backend, the pure-JavaScript
// `browser`/`default` path, and the XS host-streaming path — can be
// cross-checked against the same canonical answers.
//
// Each entry is `[asciiMessage, hexDigest]`. The messages are the NIST /
// RFC 6234 SHA-256 examples and are pure ASCII, so a consumer that lacks
// `TextEncoder` (such as a legacy XS host) can encode them with a trivial
// per-character map. This module holds only data and depends on no host
// globals, so it imports cleanly under `xst -m` as well as under Node.

import harden from '@endo/harden';

export const sha256Vectors = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
];
harden(sha256Vectors);
