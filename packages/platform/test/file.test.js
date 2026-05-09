import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeFile } from '../src/fs-node/file.js';
import { makeIteratorRef } from '../src/fs/reader-ref.js';

/**
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<string>}
 */
const makeTemporaryDirectory = async _t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'endo-test-'));
  return dir;
};

test('makeFile text round-trip', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'hello.txt');
  await fs.promises.writeFile(filePath, 'initial', 'utf-8');

  const file = makeFile(filePath);

  t.is(await file.text(), 'initial');

  await file.writeText('updated');
  t.is(await file.text(), 'updated');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeFile json round-trip', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'data.json');
  await fs.promises.writeFile(filePath, '{"a":1}', 'utf-8');

  const file = makeFile(filePath);

  t.deepEqual(await file.json(), { a: 1 });

  await fs.promises.rm(dir, { recursive: true });
});

test('makeFile append', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'log.txt');
  await fs.promises.writeFile(filePath, 'line1\n', 'utf-8');

  const file = makeFile(filePath);

  await file.append('line2\n');
  t.is(await file.text(), 'line1\nline2\n');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeFile readOnly returns ReadableBlob', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'readme.txt');
  await fs.promises.writeFile(filePath, 'read me', 'utf-8');

  const file = makeFile(filePath);
  const ro = file.readOnly();

  t.is(await ro.text(), 'read me');

  // readOnly should not expose write methods
  t.is(typeof ro.writeText, 'undefined');
  t.is(typeof ro.append, 'undefined');

  // readOnly is cached
  t.is(file.readOnly(), ro);

  await fs.promises.rm(dir, { recursive: true });
});

test('makeFile streamBase64 produces base64 chunks', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'stream.txt');
  await fs.promises.writeFile(filePath, 'hello', 'utf-8');

  const file = makeFile(filePath);
  const readerRef = file.streamBase64();

  // Consume the stream
  const chunks = [];
  await null;
  let result = await readerRef.next();
  while (!result.done) {
    chunks.push(result.value);
    // eslint-disable-next-line no-await-in-loop
    result = await readerRef.next();
  }

  // Decode base64 and verify content
  const joined = chunks.join('');
  // eslint-disable-next-line no-undef
  const binary = atob(joined);
  t.is(binary, 'hello');

  await fs.promises.rm(dir, { recursive: true });
});

test('makeFile snapshot throws without store', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'snap.txt');
  await fs.promises.writeFile(filePath, 'content', 'utf-8');

  const file = makeFile(filePath);

  await t.throwsAsync(() => file.snapshot(), {
    message: 'No snapshot store provided',
  });

  await fs.promises.rm(dir, { recursive: true });
});

test('makeFile writeBytes overwrites content from a remote-shaped reader', async t => {
  const dir = await makeTemporaryDirectory(t);
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'bytes.bin');
  await fs.promises.writeFile(filePath, 'old content', 'utf-8');

  // The writeBytes parameter is a remotable async iterator of Uint8Array
  // (the form that crosses CapTP from a remote `streamBase64()` result).
  // makeIteratorRef wraps a plain async iterable as an Exo so it
  // satisfies the FileInterface.writeBytes guard's M.remotable() shape.
  const chunks = [
    new TextEncoder().encode('first '),
    new TextEncoder().encode('second '),
    new TextEncoder().encode('third'),
  ];
  const readableRef = makeIteratorRef(
    (async function* gen() {
      for (const chunk of chunks) yield chunk;
    })(),
  );

  const file = makeFile(filePath);
  await file.writeBytes(readableRef);

  t.is(await file.text(), 'first second third');
});

test('makeFile snapshot delegates to the store', async t => {
  const dir = await makeTemporaryDirectory(t);
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'snap.txt');
  await fs.promises.writeFile(filePath, 'snapshot me', 'utf-8');

  /** @type {Uint8Array | undefined} */
  let stored;
  /** @type {string | undefined} */
  let loadCalledWith;
  const fakeBlob = harden({
    text: async () => 'fake-blob',
  });
  const fakeStore = harden({
    store: async readable => {
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
      }
      stored = total;
      return 'sha-fake';
    },
    loadBlob: sha => {
      loadCalledWith = sha;
      return fakeBlob;
    },
  });

  const file = makeFile(filePath, { store: /** @type {any} */ (fakeStore) });
  const blob = await file.snapshot();

  t.is(blob, fakeBlob, 'snapshot returns the loaded blob');
  t.is(loadCalledWith, 'sha-fake', 'snapshot calls loadBlob with the sha');
  t.is(
    new TextDecoder().decode(stored),
    'snapshot me',
    'store received the file bytes',
  );
});
