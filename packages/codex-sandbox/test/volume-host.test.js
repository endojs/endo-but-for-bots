// @ts-check
import '@endo/init';
import test from 'ava';

import {
  makePodmanSessionVolumes,
  makeXfsSessionQuota,
} from '../src/volume-host.js';

const request = harden({
  name: 'volume',
  ownerId: 'owner',
  sessionId: 'session',
  role: 'workspace',
});
const mountpoint = '/volumes/volume/_data';
const identity = harden({
  name: 'volume',
  mountpoint,
  device: '12',
  inode: '42',
});

const podmanFixture = (contents = []) => {
  const calls = [];
  let owner = '0:0';
  const volumes = makePodmanSessionVolumes({
    volumeRoot: '/volumes',
    realpath: async p => p,
    readdir: async () => contents,
    stat: async () => ({ dev: 12n, ino: 42n, isDirectory: () => true }),
    run: async argv => {
      calls.push(argv);
      if (argv[0] === 'volume' && argv[1] === 'inspect')
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              Name: 'volume',
              Driver: 'local',
              Mountpoint: mountpoint,
              Options: {},
              Labels: {
                'endo.floot.owner': 'owner',
                'endo.floot.session': 'session',
                'endo.floot.role': 'workspace',
              },
            },
          ]),
        };
      if (argv[0] === 'unshare' && argv[1] === 'stat')
        return { code: 0, stdout: owner };
      if (argv[0] === 'unshare' && argv[1] === 'chown') owner = '1000:1000';
      return { code: 0, stdout: '' };
    },
  });
  return { volumes, calls };
};

test('empty volume ownership is initialized nonrecursively and verified', async t => {
  const { volumes, calls } = podmanFixture();
  t.deepEqual(await volumes.ensure(request), identity);
  t.deepEqual(
    calls.find(args => args.includes('chown')),
    ['unshare', 'chown', '1000:1000', '--', mountpoint],
  );
});

test('nonempty volume with unexpected ownership is never chowned', async t => {
  const { volumes, calls } = podmanFixture(['user-data']);
  await t.throwsAsync(() => volumes.ensure(request), {
    message: /nonempty session volume/,
  });
  t.false(calls.some(args => args.includes('chown')));
});

test('existing mismatched quota is not overwritten during initialization retry', async t => {
  const calls = [];
  const quota = makeXfsSessionQuota({
    volumeRoot: '/volumes',
    filesystem: '/storage',
    realpath: async p => p,
    readdir: async () => [],
    stat: async () => ({ dev: 12n, ino: 42n }),
    run: async (...args) => {
      calls.push(args);
      return '';
    },
    observer: harden({
      observe: async () =>
        harden({ ...identity, projectId: 99, hardBytes: 1024n }),
    }),
  });
  await t.throwsAsync(
    () =>
      quota.ensure({
        ...identity,
        projectId: 100,
        hardBytes: 1024n,
        initialize: true,
      }),
    { message: /differs from durable registry/ },
  );
  t.is(calls.length, 0);
});
