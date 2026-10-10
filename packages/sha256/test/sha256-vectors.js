// @ts-check

import harden from '@endo/harden';

// FIPS 180-2 / FIPS 180-4 appendix B vectors, plus the well-known
// empty-input digest. Shared by the synchronous and asynchronous suites so
// both APIs are held to exactly the same examples.
export const sha256TestVectors = harden([
  {
    label: 'empty input',
    input: '',
    hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    label: 'one-block message: "abc"',
    input: 'abc',
    hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    label: 'two-block message (56 bytes)',
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
]);
