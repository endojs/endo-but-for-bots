// @ts-nocheck
import test from 'ava';
import { searchCompartmentDescriptor } from '../src/search.js';

const makeFakeReadPowers = files => {
  return {
    async read(location) {
      const bytes = files[location];
      if (bytes === undefined) {
        throw new Error(`File not found: ${location}`);
      }
      return bytes;
    },
    async maybeRead(location) {
      return files[location];
    },
  };
};

test('searchCompartmentDescriptor should find own package.json with read power', async t => {
  const sought = new URL('../package.json', import.meta.url).href;
  const readPowers = makeFakeReadPowers({
    [sought]: new TextEncoder().encode('{}'),
  });
  const { read } = readPowers;
  const { packageDescriptorLocation: found } = await searchCompartmentDescriptor(
    read,
    import.meta.url,
  );
  t.is(found, sought);
});

test('searchCompartmentDescriptor should find own package.json with read powers (plural)', async t => {
  const sought = new URL('../package.json', import.meta.url).href;
  const readPowers = makeFakeReadPowers({
    [sought]: new TextEncoder().encode('{}'),
  });
  const { packageDescriptorLocation: found } = await searchCompartmentDescriptor(
    readPowers,
    import.meta.url,
  );
  t.is(found, sought);
});

test('searchCompartmentDescriptor should fail to find package.json if nowhere to be found', async t => {
  const nothing = new URL('child/package.json', import.meta.url).href;
  const readPowers = makeFakeReadPowers({
    [nothing]: new Uint8Array(),
  });
  const { read } = readPowers;
  await t.throwsAsync(() => searchCompartmentDescriptor(read, import.meta.url));
});

test('searchCompartmentDescriptor should fail to find package.json if nowhere to be found with read powers (plural)', async t => {
  const nothing = new URL('child/package.json', import.meta.url).href;
  const readPowers = makeFakeReadPowers({
    [nothing]: new Uint8Array(),
  });
  await t.throwsAsync(() => searchCompartmentDescriptor(readPowers, import.meta.url));
});
