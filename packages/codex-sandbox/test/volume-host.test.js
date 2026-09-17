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

// `podman unshare` reports ids inside the daemon's own user namespace, where
// the daemon itself is 0:0. That is the identity a `keep-id` slice runs as, so
// it is what a volume Podman just created already has; `1000:1000` there is a
// subordinate id, which is what volumes created before that mapping carry.
const podmanFixture = (contents = [], owner = '0:0') => {
  const calls = [];
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
      if (argv[0] === 'unshare' && argv[1] === 'chown') owner = argv[3];
      return { code: 0, stdout: '' };
    },
  });
  return { volumes, calls };
};

test('a volume Podman just created is already the slice identity and is left alone', async t => {
  const { volumes, calls } = podmanFixture();
  t.deepEqual(await volumes.ensure(request), identity);
  t.false(calls.some(args => args.includes('chown')));
});

test('a volume from before the keep-id mapping is re-owned rather than stranded', async t => {
  // Observed on the deployment: a session created under the old mapping
  // carries a subordinate id, and its next turn failed with "Cannot change
  // ownership of a nonempty session volume" — a session that can never start
  // again. The volume's labels already proved it is this session's own, so
  // re-owning it is restoring access to its work, not taking a stranger's.
  const { volumes, calls } = podmanFixture(['user-data'], '1000:1000');
  t.deepEqual(await volumes.ensure(request), identity);
  t.deepEqual(
    calls.find(args => args.includes('chown')),
    ['unshare', 'chown', '-R', '0:0', '--', mountpoint],
  );
});

test('an unverifiable volume is refused before any ownership change', async t => {
  // The label check is what establishes whose volume this is; the chown above
  // is only safe because it runs after that.
  const { volumes, calls } = podmanFixture([], '1000:1000');
  await t.throwsAsync(
    () => volumes.ensure({ ...request, ownerId: 'someone-else' }),
    {
      message: /ownership or backing mismatch/,
    },
  );
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
