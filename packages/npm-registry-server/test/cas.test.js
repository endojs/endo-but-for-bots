// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { makeFileCas } from '../src/cas.js';
import { makeTemporaryDirectory } from './_fixtures.js';

test('put returns the sha256 of the bytes and get returns them', t => {
  const directory = path.join(makeTemporaryDirectory(), 'cas');
  const cas = makeFileCas(directory);
  for (const size of [0, 1, 4096, 1024 * 1024 + 3]) {
    const bytes = new Uint8Array(size).map((_, index) => index % 251);
    const hash = cas.put(bytes);
    t.is(hash, createHash('sha256').update(bytes).digest('hex'));
    t.true(cas.has(hash));
    t.deepEqual(cas.get(hash), bytes);
  }
});

test('put is idempotent and leaves no temporary files', t => {
  const directory = path.join(makeTemporaryDirectory(), 'cas');
  const cas = makeFileCas(directory);
  const bytes = new TextEncoder().encode('same bytes');
  const hash = cas.put(bytes);
  t.is(cas.put(bytes), hash);
  t.deepEqual(fs.readdirSync(directory), [hash]);
});

test('has is false and get throws for an absent blob', t => {
  const cas = makeFileCas(path.join(makeTemporaryDirectory(), 'cas'));
  const absent = '0'.repeat(64);
  t.false(cas.has(absent));
  t.throws(() => cas.get(absent));
});

test('a hash that is not sha256 hex is refused', t => {
  const cas = makeFileCas(path.join(makeTemporaryDirectory(), 'cas'));
  t.throws(() => cas.get('../escape'), { message: /Invalid CAS hash/ });
  t.throws(() => cas.has('A'.repeat(64)), { message: /Invalid CAS hash/ });
});
