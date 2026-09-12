// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { makeBwrapDriver } from '../src/drivers/bwrap.js';
import { makePodmanDriver } from '../src/drivers/podman.js';
import { makeSandboxFactory } from '../src/factory.js';
import { validateGeneratedFiles } from '../src/generated-files.js';

const files = harden([
  { innerPath: '/etc/resolv.conf', contents: 'nameserver 127.0.0.53\n' },
]);

test('literal configuration keeps exact bytes and allows distinct sibling destinations', t => {
  t.deepEqual(
    validateGeneratedFiles(files, ['/etc/other', '/workspace']),
    files,
  );
  t.deepEqual(
    validateGeneratedFiles([
      ...files,
      { innerPath: '/etc/resolv.conf2', contents: '' },
    ]),
    [...files, { innerPath: '/etc/resolv.conf2', contents: '' }],
  );
});

for (const path of [
  '',
  '/',
  'etc/config',
  '/etc//config',
  '/etc/./config',
  '/etc/../config',
  '/etc/config/',
  '/etc/\0config',
]) {
  test(`configuration refuses noncanonical destination ${JSON.stringify(path)}`, t => {
    t.throws(
      () => validateGeneratedFiles([{ innerPath: path, contents: '' }]),
      { message: /canonical/ },
    );
  });
}

for (const destination of [
  '/etc/resolv.conf',
  '/etc',
  '/etc/resolv.conf/child',
  '/',
]) {
  test(`configuration refuses a mount overlapping ${destination}`, t => {
    t.throws(() => validateGeneratedFiles(files, [destination]), {
      message: /overlaps/,
    });
  });
}

test('configuration refuses file overlap in either order and runtime mounts', t => {
  const parent = { innerPath: '/etc/app', contents: '' };
  const child = { innerPath: '/etc/app/config', contents: '' };
  for (const pair of [
    [parent, child],
    [child, parent],
    [parent, parent],
  ]) {
    t.throws(() => validateGeneratedFiles(pair), { message: /overlaps/ });
  }
  for (const path of [
    '/proc/config',
    '/sys/config',
    '/dev/config',
    '/tmp/config',
    '/scratch/config',
  ]) {
    t.throws(
      () => validateGeneratedFiles([{ innerPath: path, contents: '' }]),
      { message: /overlaps/ },
    );
  }
  t.throws(() => validateGeneratedFiles(files, ['/work/../etc']), {
    message: /canonical/,
  });
});

test('configuration records convey no host source path or writable option', t => {
  for (const extra of [
    { source: '/host/secret' },
    { mode: 'rw' },
    { executable: true },
  ]) {
    t.throws(() => validateGeneratedFiles([{ ...files[0], ...extra }]));
  }
});

for (const { name, makeDriver } of [
  { name: 'bwrap', makeDriver: makeBwrapDriver },
  { name: 'podman', makeDriver: makePodmanDriver },
]) {
  test(`${name} rejects generated files before host resource acquisition`, async t => {
    const driver = makeDriver();
    await t.throwsAsync(
      driver.prepareSlice(/** @type {any} */ ({ generatedFiles: files })),
      {
        message:
          /does not yet support generated files|requires generated file storage/,
      },
    );
  });
}

test('factory selects explicit generated-file support and forwards exact configuration', async t => {
  const calls = [];
  const base = {
    probe: async () =>
      harden({ available: true, details: { lifecycle: { available: true } } }),
    prepareSlice: async spec => {
      calls.push(spec);
      return harden({});
    },
    spawn: async () => {
      throw Error('not used');
    },
    teardown: async () => {},
  };
  const factory = makeSandboxFactory({
    drivers: /** @type {any} */ (
      harden([
        {
          ...base,
          name: 'bwrap',
          prepareSlice: async () => {
            throw Error('unsupported driver selected');
          },
        },
        { ...base, name: 'podman', supportsGeneratedFiles: true },
      ])
    ),
    scratchProvider: /** @type {any} */ (
      harden({
        provideScratchMount: async () => {
          throw Error('no scratch');
        },
      })
    ),
  });
  const handle = await E(factory).make(
    harden({ rootfs: { kind: 'host-bind' }, generatedFiles: files }),
  );
  t.teardown(() => E(handle).dispose());
  t.is(calls.length, 1);
  t.deepEqual(calls[0].generatedFiles, files);
  await t.throwsAsync(
    E(factory).make(
      harden({
        rootfs: { kind: 'host-bind' },
        generatedFiles: files,
        backend: 'bwrap',
      }),
    ),
    {
      message: /supports generated files/,
    },
  );
});

test('invalid generated destinations reject before probing or resolving mount capabilities', async t => {
  let acquisitions = 0;
  const acquire = async () => {
    acquisitions += 1;
    throw Error('unexpected acquisition');
  };
  const factory = makeSandboxFactory({
    drivers: /** @type {any} */ (
      harden([{ name: 'podman', supportsGeneratedFiles: true, probe: acquire }])
    ),
    scratchProvider: /** @type {any} */ (
      harden({ provideScratchMount: acquire, provideHostPath: acquire })
    ),
  });
  await t.throwsAsync(
    E(factory).make(
      harden({
        rootfs: { kind: 'host-bind' },
        generatedFiles: [{ innerPath: '/scratch/config', contents: '' }],
      }),
    ),
    {
      message: /overlaps/,
    },
  );
  t.is(acquisitions, 0);
});

test('Podman refuses malformed host allocators instead of advertising file support', t => {
  for (const generatedFileStorage of [
    null,
    {},
    { makeStage() {} },
    { close() {} },
  ]) {
    t.throws(
      () => makePodmanDriver(/** @type {any} */ ({ generatedFileStorage })),
      {
        message: /storage must provide makeStage and close/,
      },
    );
  }
});
