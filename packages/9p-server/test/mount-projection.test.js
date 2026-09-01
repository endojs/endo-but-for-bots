// @ts-nocheck

/**
 * Unit tests for the shared mount-projection layer, exercised through
 * its injected seams (`mounter`, `resolveHostPath`, `provideMount`,
 * `asFilesystem`) so both branches run without a kernel mount, a 9P
 * bridge, or a daemon.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import { makeMountProjector } from '../mount-projection.js';

const fakeMount = label => Far('FakeMount', { label: () => label });

/**
 * @param {object} [opts]
 * @param {(fs: unknown, mountPoint: string, options: object) => unknown} [opts.mountBehavior]
 */
const makeHarness = (opts = {}) => {
  const calls = {
    mount: [],
    unmount: [],
    provideMount: [],
    asFilesystem: [],
  };
  const mounter = Far('FakeMounter', {
    async mount(fs, mountPoint, options) {
      calls.mount.push({ fs, mountPoint, options });
      if (opts.mountBehavior) {
        return opts.mountBehavior(fs, mountPoint, options);
      }
      return Far('FakeMountHandle', {
        async unmount() {
          calls.unmount.push(mountPoint);
        },
      });
    },
  });
  const asFilesystem = (cap, options) => {
    calls.asFilesystem.push({ cap, options });
    return Far('FakeFilesystem', { of: () => cap });
  };
  return { calls, mounter, asFilesystem };
};

test('a physically-backed mount projects to its own directory', async t => {
  const { calls, mounter, asFilesystem } = makeHarness();
  const mount = fakeMount('physical');
  const projector = makeMountProjector({
    mounter,
    asFilesystem,
    resolveHostPath: async cap => (cap === mount ? '/srv/project' : undefined),
  });

  const projection = await projector.projectMount(mount, {
    mountPoint: '/run/endo/mnt/0',
  });

  t.is(projection.kind, 'physical');
  t.is(projection.hostPath, '/srv/project');
  t.is(projection.mountCap, mount);
  // No bridge, no kernel mount, nothing to project through.
  t.is(calls.mount.length, 0);
  t.is(calls.asFilesystem.length, 0);
  await projection.release();
  t.is(calls.unmount.length, 0);
});

test('a mount with no physical backing projects over 9P', async t => {
  const { calls, mounter, asFilesystem } = makeHarness();
  const mount = fakeMount('remote');
  const projector = makeMountProjector({
    mounter,
    asFilesystem,
    resolveHostPath: async () => undefined,
  });

  const projection = await projector.projectMount(mount, {
    mountPoint: '/run/endo/mnt/0',
  });

  t.is(projection.kind, '9p');
  t.is(projection.hostPath, '/run/endo/mnt/0');
  t.is(calls.asFilesystem.length, 1);
  t.is(calls.asFilesystem[0].cap, mount);
  t.is(calls.asFilesystem[0].options.posture, 'readWrite');
  t.is(calls.mount.length, 1);
  t.is(calls.mount[0].mountPoint, '/run/endo/mnt/0');
  t.is(calls.mount[0].options.readOnly, undefined);

  await projection.release();
  t.deepEqual(calls.unmount, ['/run/endo/mnt/0']);
  // Idempotent: a second release does not unmount twice.
  await projection.release();
  t.is(calls.unmount.length, 1);
});

test('a read-only projection is mounted ro and labelled readOnly', async t => {
  const { calls, mounter, asFilesystem } = makeHarness();
  const projector = makeMountProjector({ mounter, asFilesystem });

  await projector.projectMount(fakeMount('ro'), {
    mountPoint: '/run/endo/mnt/1',
    readOnly: true,
  });

  t.is(calls.asFilesystem[0].options.posture, 'readOnly');
  t.true(calls.mount[0].options.readOnly);
});

test('default mount options apply to every projection and are overridable', async t => {
  const { calls, mounter, asFilesystem } = makeHarness();
  const projector = makeMountProjector({
    mounter,
    asFilesystem,
    defaultMountOptions: { lazyUnmount: true, cache: 'none' },
  });

  await projector.projectFilesystem(Far('Fs', {}), {
    mountPoint: '/run/endo/mnt/2',
    mountOptions: { cache: 'loose' },
  });

  t.true(calls.mount[0].options.lazyUnmount);
  t.is(calls.mount[0].options.cache, 'loose');
});

test('provideMount registers the mountpoint and its failure releases the mount', async t => {
  const { calls, mounter, asFilesystem } = makeHarness();
  const cap = Far('WorkspaceMount', {});
  const projector = makeMountProjector({
    mounter,
    asFilesystem,
    provideMount: async hostPath => {
      calls.provideMount.push(hostPath);
      return cap;
    },
  });

  const projection = await projector.projectFilesystem(Far('Fs', {}), {
    mountPoint: '/run/endo/mnt/3',
  });
  t.is(projection.mountCap, cap);
  t.deepEqual(calls.provideMount, ['/run/endo/mnt/3']);

  const failing = makeMountProjector({
    mounter,
    asFilesystem,
    provideMount: async () => {
      throw new Error('name taken');
    },
  });
  await t.throwsAsync(
    failing.projectFilesystem(Far('Fs', {}), { mountPoint: '/run/endo/mnt/4' }),
    { message: /name taken/ },
  );
  // The kernel mount is not leaked behind a registration that failed.
  t.true(calls.unmount.includes('/run/endo/mnt/4'));
});

test('release reports an unmount failure rather than rejecting', async t => {
  const { mounter, asFilesystem } = makeHarness({
    mountBehavior: () =>
      Far('StuckMountHandle', {
        async unmount() {
          throw new Error('device is busy');
        },
      }),
  });
  const projector = makeMountProjector({ mounter, asFilesystem });
  const projection = await projector.projectFilesystem(Far('Fs', {}), {
    mountPoint: '/run/endo/mnt/5',
  });
  t.false(await projection.release());
});

test('a projector with no mounter refuses rather than degrading', async t => {
  const projector = makeMountProjector({
    resolveHostPath: async () => undefined,
  });
  await t.throwsAsync(
    projector.projectMount(fakeMount('remote'), {
      mountPoint: '/run/endo/mnt/6',
      label: 'workspace',
    }),
    { message: /needs a 9P mounter/ },
  );
});

test('a 9P projection requires a mountPoint', async t => {
  const { mounter, asFilesystem } = makeHarness();
  const projector = makeMountProjector({ mounter, asFilesystem });
  await t.throwsAsync(
    projector.projectFilesystem(Far('Fs', {}), { mountPoint: '' }),
    { message: /requires a mountPoint/ },
  );
});

test('a throwing physical resolver propagates instead of falling through', async t => {
  const { calls, mounter, asFilesystem } = makeHarness();
  const projector = makeMountProjector({
    mounter,
    asFilesystem,
    resolveHostPath: async () => {
      throw new Error('collected mount formula');
    },
  });
  await t.throwsAsync(
    projector.projectMount(fakeMount('gone'), {
      mountPoint: '/run/endo/mnt/7',
    }),
    { message: /collected mount formula/ },
  );
  t.is(calls.mount.length, 0);
});
