// @ts-check
import '@endo/init';

import test from 'ava';
import { E } from '@endo/eventual-send';

import { makeCodexDurableVolumeProvider } from '../src/durable-volumes.js';

const fixture = (projectIds = { first: 1000, last: 2000 }) => {
  let saved = { version: 1, nextProjectId: 1, sessions: {} };
  let chain = Promise.resolve();
  const physical = new Map();
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
  const reopen = () =>
    makeCodexDurableVolumeProvider({
      ownerId: 'operator-1',
      projectIds,
      registry,
      volumes,
      quota,
    });
  return {
    reopen,
    acknowledge: callback => {
      acknowledge = callback;
    },
    failSave: predicate => {
      failSave = predicate;
    },
    physical,
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

test('durable volumes reopen unchanged and leases preserve data', async t => {
  const f = fixture();
  const provider = f.reopen();
  const spec = { sessionId: 's1' };
  const workspace = await provider.makeWorkspace(spec);
  const names = [...f.physical.keys()];
  const lease = await provider.mountWorkspace(workspace, spec);
  const description = await E(provider.volumeProvider).describe(lease, spec);
  t.is(description.workspaceVolume, names[0]);
  await E(lease).unmount();
  t.is(f.physical.size, 2);
  await f.reopen().makeWorkspace(spec);
  t.deepEqual([...f.physical.keys()], names);
  await t.throwsAsync(() => E(provider.volumeProvider).describe(lease, spec), {
    message: /retired volume lease/,
  });
});

test('partial creation resumes reserved projects without removing first volume', async t => {
  const f = fixture();
  f.failRole('state');
  await t.throwsAsync(() => f.reopen().makeWorkspace({ sessionId: 's1' }), {
    message: /injected/,
  });
  t.is(f.physical.size, 1);
  const project = f.state().sessions.s1.volumes[0].projectId;
  f.failRole('');
  await f.reopen().makeWorkspace({ sessionId: 's1' });
  t.is(f.state().sessions.s1.volumes[0].projectId, project);
  t.is(f.state().nextProjectId, 1002);
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
  t.is(f.state().sessions.s1.volumes[0].projectId, 1002);
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
