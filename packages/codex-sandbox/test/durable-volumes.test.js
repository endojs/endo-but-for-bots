// @ts-check
import '@endo/init';

import test from 'ava';
import { E } from '@endo/eventual-send';

import { makeCodexDurableVolumeProvider } from '../src/durable-volumes.js';

const fixture = (projectIds = { first: 1000, last: 2000 }) => {
  let saved = { version: 1, nextProjectId: 1, sessions: {} };
  let chain = Promise.resolve();
  const physical = new Map();
  const removed = [];
  const limits = new Map();
  let failingRole = '';
  let removeFailure = false;
  /** @type {(state:any) => boolean} */
  let failSave = () => false;
  let acknowledge = async () => undefined;
  const registry = {
    transaction: operation => {
      const result = chain.then(async () => {
        const state = structuredClone(saved);
        return operation(state, async () => {
          saved = structuredClone(state);
          if (failSave(state)) {
            failSave = () => false;
            throw Error('injected lost save acknowledgement');
          }
        });
      });
      chain = result.catch(() => undefined);
      const ack = acknowledge;
      return result.then(async value => {
        await ack();
        return value;
      });
    },
  };
  const volumes = harden({
    ensure: async ({ name, role }) => {
      if (role === failingRole) throw Error('injected volume creation failure');
      if (!physical.has(name))
        physical.set(name, {
          name,
          mountpoint: `/volumes/${name}/_data`,
          device: '12',
          inode: `${physical.size + 10}`,
        });
      return harden(physical.get(name));
    },
    remove: async ({ name }) => {
      if (removeFailure) throw Error('injected remove failure');
      removed.push(name);
      physical.delete(name);
    },
    assertUnused: async () => undefined,
  });
  const quota = harden({
    ensure: async request => {
      limits.set(request.name, {
        ...request,
        enforced: true,
        projectInherited: true,
      });
    },
    observe: async ({ name }) => harden(limits.get(name)),
  });
  // The workspace is a 9P projection rather than a volume, so the provider
  // establishes one per lease. This stands in for the mounter kit: it records
  // what was projected and whether the kernel mount was taken down.
  const projections = [];
  const directories = [];
  /** @type {(path: string) => string | undefined} */
  let canonical = path => path;
  /** @param {{stateBytes: bigint}} [volumeLimits] */
  const reopen = (volumeLimits = undefined) =>
    makeCodexDurableVolumeProvider({
      ownerId: 'operator-1',
      projectIds,
      registry,
      volumes,
      quota,
      volumeLimits,
      sessionsDirectory: '/run/codex/sessions',
      mounterEnv: { MOUNT_PROGRAM: '/bin/mount' },
      provideDirectory: async (_label, directory) => {
        directories.push(directory);
      },
      canonicalDirectory: async path => canonical(path),
      projectWorkspace: (plan, powers) => {
        const record = {
          ...plan,
          powers,
          mounted: 0,
          closed: 0,
          mountPoint: plan.workspaceMountPoint,
        };
        projections.push(record);
        return harden({
          mountPoint: record.mountPoint,
          mount: async () => {
            record.mounted += 1;
          },
          close: async () => {
            record.closed += 1;
          },
        });
      },
    });
  return {
    reopen,
    projections,
    directories,
    setCanonical: resolve => {
      canonical = resolve;
    },
    seed: sessions => {
      saved = {
        version: 1,
        nextProjectId: 1002,
        ownerId: 'operator-1',
        projectIds,
        sessions,
      };
    },
    acknowledge: callback => {
      acknowledge = callback;
    },
    failSave: predicate => {
      failSave = predicate;
    },
    physical,
    removed,
    limits,
    state: () => saved,
    failRole: role => {
      failingRole = role;
    },
    failRemove: value => {
      removeFailure = value;
    },
  };
};

test('operator reductions survive reopen and refuse implicit quota migration', async t => {
  const f = fixture();
  const volumeLimits = { stateBytes: 256n * 1024n ** 2n };
  const spec = { sessionId: 'small' };
  await f.reopen(volumeLimits).makeWorkspace(spec);
  t.deepEqual(
    [...f.limits.values()].map(value => value.hardBytes),
    [volumeLimits.stateBytes],
  );
  await f.reopen(volumeLimits).makeWorkspace(spec);
  await t.throwsAsync(() => f.reopen().makeWorkspace(spec), {
    message: /limit|migration/i,
  });
});

test('durable volumes reopen unchanged and leases preserve data', async t => {
  const f = fixture();
  const provider = f.reopen();
  const spec = { sessionId: 's1' };
  const workspace = await provider.makeWorkspace(spec);
  const names = [...f.physical.keys()];
  const lease = await provider.mountWorkspace(workspace, spec);
  const description = await E(provider.volumeProvider).describe(lease, spec);
  t.deepEqual(description, {
    sessionId: 's1',
    stateVolume: names[0],
    workspaceMountPoint: '/run/codex/sessions/s1/workspace',
  });
  await E(lease).unmount();
  // The kernel mount comes down with the lease; the state volume does not.
  t.is(f.projections.at(-1)?.closed, 1);
  t.is(f.physical.size, 1);
  await f.reopen().makeWorkspace(spec);
  t.deepEqual([...f.physical.keys()], names);
  await t.throwsAsync(() => E(provider.volumeProvider).describe(lease, spec), {
    message: /retired volume lease/,
  });
});

test('partial creation resumes the reserved project without reallocating it', async t => {
  const f = fixture();
  f.failRole('state');
  await t.throwsAsync(() => f.reopen().makeWorkspace({ sessionId: 's1' }), {
    message: /injected/,
  });
  // The intent is durable before the resource: the project is reserved and
  // the record exists, even though no volume was created.
  t.is(f.physical.size, 0);
  const project = f.state().sessions.s1.volumes[0].projectId;
  f.failRole('');
  await f.reopen().makeWorkspace({ sessionId: 's1' });
  t.is(f.state().sessions.s1.volumes[0].projectId, project);
  // One ID per session now, not two.
  t.is(f.state().nextProjectId, 1001);
});

test('persisted lease blocks another provider until explicit recovery', async t => {
  const f = fixture();
  const first = f.reopen();
  const spec = { sessionId: 's1' };
  const workspace = await first.makeWorkspace(spec);
  const lease = await first.mountWorkspace(workspace, spec);
  const second = f.reopen();
  await t.throwsAsync(() => second.makeWorkspace(spec), {
    message: /outstanding durable lease/,
  });
  await t.throwsAsync(() => second.destroy(spec), {
    message: /durably leased/,
  });
  await second.recoverLease(spec);
  await t.throwsAsync(() => E(first.volumeProvider).describe(lease, spec), {
    message: /lease was revoked/,
  });
  await second.makeWorkspace(spec);
});

test('failed deletion stays tombstoned and retries without project ID reuse', async t => {
  const f = fixture();
  const provider = f.reopen();
  const spec = { sessionId: 's1' };
  await provider.makeWorkspace(spec);
  f.failRemove(true);
  await t.throwsAsync(() => provider.destroy(spec), {
    message: /injected remove/,
  });
  await t.throwsAsync(() => f.reopen().makeWorkspace(spec), {
    message: /deletion must finish/,
  });
  f.failRemove(false);
  await f.reopen().destroy(spec);
  t.is(f.physical.size, 0);
  await f.reopen().makeWorkspace(spec);
  t.is(f.state().sessions.s1.volumes[0].projectId, 1001);
});

test('changed physical identity is refused on reopen', async t => {
  const f = fixture();
  const spec = { sessionId: 's1' };
  await f.reopen().makeWorkspace(spec);
  const [name] = f.physical.keys();
  f.physical.set(name, { ...f.physical.get(name), inode: '99' });
  await t.throwsAsync(() => f.reopen().makeWorkspace(spec), {
    message: /identity changed/,
  });
});

test('concurrent mounts grant only one durable lease', async t => {
  const f = fixture();
  const p = f.reopen();
  const spec = { sessionId: 's1' };
  const w = await p.makeWorkspace(spec);
  const results = await Promise.allSettled([
    p.mountWorkspace(w, spec),
    p.mountWorkspace(w, spec),
  ]);
  t.is(results.filter(r => r.status === 'fulfilled').length, 1);
  const winner = results.find(r => r.status === 'fulfilled');
  if (winner?.status === 'fulfilled') await E(winner.value).unmount();
});

test('lost unmount acknowledgement retries without touching another lease', async t => {
  const f = fixture();
  const p = f.reopen();
  const spec = { sessionId: 's1' };
  const w = await p.makeWorkspace(spec);
  const lease = await p.mountWorkspace(w, spec);
  f.failSave(state => !state.sessions.s1.lease);
  await t.throwsAsync(() => E(lease).unmount(), {
    message: /lost save acknowledgement/,
  });
  const other = f.reopen();
  const next = await other.mountWorkspace(
    await other.makeWorkspace(spec),
    spec,
  );
  await E(lease).unmount();
  await t.notThrowsAsync(() => E(other.volumeProvider).describe(next, spec));
  await E(next).unmount();
});

test('last uint32 project pair can still be destroyed when allocation is exhausted', async t => {
  const f = fixture({ first: 0xffff_fffe, last: 0xffff_ffff });
  const p = f.reopen();
  await p.makeWorkspace({ sessionId: 'last' });
  await t.throwsAsync(() => p.makeWorkspace({ sessionId: 'beyond' }), {
    message: /exhausted/,
  });
  await p.destroy({ sessionId: 'last' });
  t.is(f.physical.size, 0);
});

test('lost lease reservation acknowledgement does not strand unpublished lease', async t => {
  const f = fixture();
  const p = f.reopen();
  const spec = { sessionId: 's1' };
  const w = await p.makeWorkspace(spec);
  f.failSave(state => Boolean(state.sessions.s1.lease));
  await t.throwsAsync(() => p.mountWorkspace(w, spec), {
    message: /lost save acknowledgement/,
  });
  const lease = await p.mountWorkspace(w, spec);
  await E(lease).unmount();
});

test('delayed concurrent unmount acknowledgement cannot retire a successor local lease', async t => {
  t.timeout(5000);
  const f = fixture();
  const p = f.reopen();
  const spec = { sessionId: 's1' };
  const w = await p.makeWorkspace(spec);
  const lease = await p.mountWorkspace(w, spec);
  /** @type {() => void} */
  let release = () => {
    throw Error('Missing delayed acknowledgement');
  };
  const delayed = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let entered;
  const secondEntered = new Promise(resolve => {
    entered = resolve;
  });
  let acknowledgements = 0;
  f.acknowledge(async () => {
    acknowledgements += 1;
    if (acknowledgements === 2) {
      entered();
      await delayed;
    }
  });
  const first = E(lease).unmount();
  const second = E(lease).unmount();
  await first;
  await secondEntered;
  const next = await p.mountWorkspace(w, spec);
  release();
  await second;
  await t.throwsAsync(() => p.recoverLease(spec), {
    message: /local live lease/,
  });
  await t.notThrowsAsync(() => E(p.volumeProvider).describe(next, spec));
  await E(next).unmount();
});

test('the workspace is the session’s own tree when it brings none', async t => {
  const f = fixture();
  const p = f.reopen();
  const spec = { sessionId: 's1' };
  const lease = await p.mountWorkspace(await p.makeWorkspace(spec), spec);
  const projection = f.projections.at(-1);
  t.is(projection?.workspaceRootPath, '/run/codex/sessions/s1/tree');
  t.is(projection?.workspaceMountPoint, '/run/codex/sessions/s1/workspace');
  t.is(projection?.mounterSocketDir, '/run/codex/sessions/s1/9p');
  t.is(projection?.mounted, 1);
  // Both are this provider's to create and own; the mount point is the
  // mounter's, which removes it on unmount.
  t.deepEqual(f.directories, [
    '/run/codex/sessions/s1/9p',
    '/run/codex/sessions/s1/tree',
  ]);
  await E(lease).unmount();
});

test('a worktree the session brings is what the slice sees', async t => {
  const f = fixture();
  const p = f.reopen();
  const spec = { sessionId: 's1', workspaceHostPath: '/srv/worktrees/s1' };
  const lease = await p.mountWorkspace(await p.makeWorkspace(spec), spec);
  t.is(f.projections.at(-1)?.workspaceRootPath, '/srv/worktrees/s1');
  // No tree of its own is created when the session supplies one.
  t.deepEqual(f.directories, ['/run/codex/sessions/s1/9p']);
  await E(lease).unmount();
});

test('a worktree must be an existing canonical directory outside the store', async t => {
  /** @type {[string, string, (path: string) => string | undefined, RegExp][]} */
  const rejected = [
    ['relative', 'srv/worktrees/s1', path => path, /absolute host path/],
    [
      'absent',
      '/srv/worktrees/gone',
      () => undefined,
      /must be an existing directory/,
    ],
    [
      'a symlink',
      '/srv/worktrees/link',
      () => '/srv/worktrees/target',
      /must be canonical/,
    ],
    [
      'inside the session store',
      '/run/codex/sessions/s1/9p',
      path => path,
      /disjoint from the session storage root/,
    ],
    [
      'the session store itself',
      '/run/codex/sessions',
      path => path,
      /disjoint from the session storage root/,
    ],
  ];
  for (const [label, workspaceHostPath, resolve, message] of rejected) {
    const f = fixture();
    f.setCanonical(resolve);
    const p = f.reopen();
    const spec = { sessionId: 's1', workspaceHostPath };
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      async () => p.mountWorkspace(await p.makeWorkspace(spec), spec),
      { message },
      label,
    );
    // A refused workspace leaves no lease behind for a successor to trip on.
    // eslint-disable-next-line no-await-in-loop
    await t.notThrowsAsync(() => f.reopen().makeWorkspace(spec), label);
  }
});

test('a record written before the workspace volume was dropped retires it', async t => {
  const f = fixture();
  const spec = { sessionId: 's1' };
  // A record as the two-volume provider wrote it: the workspace volume holds
  // the lower of the pair's project IDs, and its quota is its own.
  f.seed({
    s1: {
      phase: 'ready',
      sessionId: 's1',
      volumes: [
        {
          role: 'workspace',
          name: 'legacy-workspace-s1',
          projectId: 1000,
          hardBytes: `${8n * 1024n ** 3n}`,
          ready: true,
        },
        {
          role: 'state',
          name: 'legacy-state-s1',
          projectId: 1001,
          hardBytes: `${4n * 1024n ** 3n}`,
          ready: true,
        },
      ],
    },
  });
  // The retired volume exists on the host, as it would on a machine that ran
  // the two-volume provider.
  f.physical.set('legacy-workspace-s1', {
    name: 'legacy-workspace-s1',
    mountpoint: '/volumes/legacy-workspace-s1/_data',
    device: '12',
    inode: '9',
  });
  const p = f.reopen();
  // Reopening neither re-ensures the retired volume nor refuses the record
  // for carrying a quota this provider no longer allocates.
  await p.makeWorkspace(spec);
  t.deepEqual([...f.limits.keys()], ['legacy-state-s1']);
  const lease = await p.mountWorkspace(await p.makeWorkspace(spec), spec);
  const description = await E(p.volumeProvider).describe(lease, spec);
  t.is(description.stateVolume, 'legacy-state-s1');
  t.is(description.workspaceMountPoint, '/run/codex/sessions/s1/workspace');
  await E(lease).unmount();
  // Retired is not forgotten: destroy still removes it, and its project ID
  // is never reused.
  await p.destroy(spec);
  t.deepEqual(f.removed, ['legacy-workspace-s1', 'legacy-state-s1']);
  t.is(f.physical.size, 0);
  await f.reopen().makeWorkspace(spec);
  t.is(f.state().sessions.s1.volumes[0].projectId, 1002);
});
