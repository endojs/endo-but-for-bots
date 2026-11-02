// @ts-check
import '@endo/init';
import test from 'ava';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_CONTEXT_LIMIT, isUuid } from '../oci/native-context-shape.mjs'; // eslint-disable-line import/no-relative-packages

test('the wire bound and identity pattern are the shared ones', t => {
  t.is(NATIVE_CONTEXT_LIMIT, 16 * 1024 * 1024);
  t.true(isUuid('01a0d26e-d933-71c1-a255-d6f7c2e256f0'));
  for (const value of [
    '01A0D26E-D933-71C1-A255-D6F7C2E256F0',
    '01a0d26ed93371c1a255d6f7c2e256f0',
    ' 01a0d26e-d933-71c1-a255-d6f7c2e256f0',
    12,
    undefined,
    null,
    {},
  ]) {
    t.false(isUuid(value), String(value));
  }
});

const oci = fileURLToPath(new URL('../oci/', import.meta.url));
// Every sibling module a helper names, whether through `import ... from`,
// `import()` or `new URL(..., import.meta.url)`.
const relativeImports = async name => {
  const text = await readFile(path.join(oci, name), 'utf8');
  return [...text.matchAll(/['"]\.\/([^'"]+\.mjs)['"]/g)].map(
    match => match[1],
  );
};

test('the image carries every module the helper imports', async t => {
  // The helper runs from /opt/endo inside the image, so a module it imports
  // but the Containerfile does not copy fails only at capture or restoration
  // time, in a live session.
  const containerfile = await readFile(path.join(oci, 'Containerfile'), 'utf8');
  const copies = new Map();
  for (const line of containerfile.split('\n')) {
    const match = /^COPY\s+(.+\S)\s+(\S+)\s*$/.exec(line);
    if (match) {
      const sources = match[1].split(/\s+/);
      const destination = match[2];
      for (const source of sources) {
        copies.set(
          source,
          destination.endsWith('/') ? destination + source : destination,
        );
      }
    }
  }
  const reachable = new Set();
  const queue = ['context-command.mjs'];
  while (queue.length) {
    const name = /** @type {string} */ (queue.shift());
    if (!reachable.has(name)) {
      reachable.add(name);
      // eslint-disable-next-line no-await-in-loop
      queue.push(...(await relativeImports(name)));
    }
  }
  t.true(reachable.has('native-context-shape.mjs'));
  for (const name of reachable) {
    t.is(copies.get(name), `/opt/endo/${name}`, `${name} is copied`);
  }
  for (const [source, destination] of copies) {
    if (source.endsWith('.mjs')) {
      t.true(reachable.has(source), `${source} is used by the helper`);
      t.is(destination, `/opt/endo/${source}`);
    }
  }
});

test('the wire shape is written down once', async t => {
  // The bound and the identity pattern used to be declared in each helper and
  // in the host transport, kept in step by hand.
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const ociNames = await readdir(oci);
  const srcNames = await readdir(src);
  const definitions = new Map();
  const scan = async (file, tokens) => {
    const text = await readFile(file, 'utf8');
    for (const token of tokens) {
      if (text.includes(token)) {
        definitions.set(token, [
          ...(definitions.get(token) ?? []),
          path.basename(file),
        ]);
      }
    }
  };
  for (const name of ociNames.filter(n => n.endsWith('.mjs'))) {
    // eslint-disable-next-line no-await-in-loop
    await scan(path.join(oci, name), ['16 * 1024 * 1024', '[a-f0-9]{8}']);
  }
  for (const name of srcNames.filter(n => n.endsWith('.js'))) {
    // Other 16 MiB bounds exist in the host (journal values, early bytes);
    // only the identity pattern and the transport's own bound are the shape.
    // eslint-disable-next-line no-await-in-loop
    await scan(path.join(src, name), ['[a-f0-9]{8}']);
  }
  t.deepEqual([...definitions.entries()].sort(), [
    ['16 * 1024 * 1024', ['native-context-shape.mjs']],
    ['[a-f0-9]{8}', ['native-context-shape.mjs']],
  ]);
  const transport = await readFile(
    path.join(src, 'native-context-transport.js'),
    'utf8',
  );
  t.false(transport.includes('1024 * 1024'));
  t.true(transport.includes("from '../oci/native-context-shape.mjs'"));
});
