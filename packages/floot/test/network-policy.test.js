// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeSessionNetworkPolicy } from '../src/network-policy.js';

const fixture = () => {
  const values = new Map();
  let failWrite = false;
  let failCompletion = false;
  let failStop = false;
  let busy = false;
  let supported = ['off', 'public-internet'];
  let stops = 0;
  let preparations = 0;
  const host = Far('NetworkPolicyStorage', {
    list: () => harden([...values.keys()]),
    lookup: name => values.get(name),
    storeValue: (value, name) => {
      if (values.has(name)) throw Error('Overwrite');
      values.set(name, value);
      if (failWrite || (failCompletion && value.action === 'change-completed'))
        throw Error('Acknowledgement lost');
    },
  });
  const create = () =>
    makeSessionNetworkPolicy({
      host,
      id: 'test',
      supported: async () => supported,
      prepare: async () => {
        preparations += 1;
        if (busy) throw Error('Active turn');
      },
      change: async () => {
        stops += 1;
        if (failStop) throw Error('Still stopping');
      },
    });
  return {
    create,
    values,
    stops: () => stops,
    preparations: () => preparations,
    failWrite: () => {
      failWrite = true;
    },
    failCompletion: () => {
      failCompletion = true;
    },
    stopFailure: value => {
      failStop = value;
    },
    busy: value => {
      busy = value;
    },
    unsupported: () => {
      supported = [];
    },
  };
};

test('request cannot grant access; explicit CAS approval does', async t => {
  const f = fixture();
  const controller = f.create();
  t.is(await controller.forTurn(), 'off');
  const request = await controller.request(
    'public-internet',
    'Install dependencies',
  );
  t.is(await controller.forTurn(), 'off');
  t.deepEqual(
    await controller.request('public-internet', 'Install dependencies'),
    request,
  );
  await t.throwsAsync(controller.resolve('stale', true, 'Checked'));
  await t.throwsAsync(controller.resolve(request.id, true, '  '));
  t.is(
    (await controller.resolve(request.id, true, 'Approved public downloads'))
      .policy,
    'public-internet',
  );
  t.is(f.stops(), 1);
  await t.throwsAsync(controller.resolve(request.id, true, 'Replay'));
  t.is(await f.create().forTurn(), 'public-internet');
});

test('denial is durable and does not stop or broaden a sandbox', async t => {
  const f = fixture();
  const controller = f.create();
  const request = await controller.request('public-internet', 'Download Rust');
  await controller.resolve(request.id, false, 'Not approved');
  t.is(f.stops(), 0);
  t.is(await f.create().forTurn(), 'off');
  t.is((await f.create().get()).request, undefined);
});

test('failed teardown leaves durable transition fenced and retryable', async t => {
  const f = fixture();
  const controller = f.create();
  f.stopFailure(true);
  await t.throwsAsync(controller.set('public-internet'), {
    message: /Still stopping/,
  });
  const revived = f.create();
  t.is((await revived.get()).pendingPolicy, 'public-internet');
  await t.throwsAsync(revived.forTurn(), { message: /incomplete/ });
  await t.throwsAsync(revived.set('off'), { message: /pending/ });
  f.stopFailure(false);
  t.is((await revived.set('public-internet')).policy, 'public-internet');
});

test('uncertain intent write fences incarnation and revival before dispatch', async t => {
  const f = fixture();
  const controller = f.create();
  f.failWrite();
  await t.throwsAsync(controller.set('public-internet'));
  t.is(f.stops(), 0);
  await t.throwsAsync(controller.forTurn(), { message: /uncertain/ });
  await t.throwsAsync(f.create().forTurn(), { message: /incomplete/ });
});

test('busy and unsupported backends never publish policy grants', async t => {
  const f = fixture();
  const controller = f.create();
  f.busy(true);
  await t.throwsAsync(controller.set('public-internet'), { message: /Active/ });
  t.is(f.values.size, 0);
  f.busy(false);
  f.unsupported();
  t.is((await controller.get()).policy, null);
  t.is(await controller.forTurn(), undefined);
  await t.throwsAsync(controller.set('off'), { message: /does not enforce/ });
  await t.throwsAsync(controller.request('public-internet', 'Download'));
  t.is(f.values.size, 0);
});

test('loss of configured enforcement fails closed rather than ignoring policy', async t => {
  const f = fixture();
  const controller = f.create();
  await controller.set('off');
  f.unsupported();
  await t.throwsAsync(controller.forTurn(), { message: /unavailable/ });
});

test('capacity always reserves durable public revocation', async t => {
  const f = fixture();
  for (let index = 1; index <= 4092; index += 1) {
    f.values.set(
      `floot-network-4-test-${`${index}`.padStart(20, '0')}`,
      harden({ version: 1, revision: `${index}`, policy: 'off' }),
    );
  }
  const controller = f.create();
  await controller.set('public-internet');
  await t.throwsAsync(controller.request('off', 'Consume reserved space'), {
    message: /reserves capacity/,
  });
  t.is(await controller.forTurn(), 'public-internet');
  await controller.set('off');
  t.is(f.values.size, 4096);
  t.is(await f.create().forTurn(), 'off');
  t.is(f.stops(), 2);
});

test('invalid transition retries and exhausted grants do not freeze an agent', async t => {
  const f = fixture();
  for (let index = 1; index <= 4093; index += 1) {
    f.values.set(
      `floot-network-4-test-${`${index}`.padStart(20, '0')}`,
      harden({ version: 1, revision: `${index}`, policy: 'off' }),
    );
  }
  await t.throwsAsync(f.create().set('public-internet'), {
    message: /capacity/,
  });
  t.is(f.preparations(), 0);
  const pending = fixture();
  pending.stopFailure(true);
  const controller = pending.create();
  await t.throwsAsync(controller.set('public-internet'));
  const before = pending.preparations();
  await t.throwsAsync(controller.set('off'), { message: /pending/ });
  t.is(pending.preparations(), before);
});

test('completion acknowledgement loss revives only the durably committed policy', async t => {
  const f = fixture();
  const controller = f.create();
  f.failCompletion();
  await t.throwsAsync(controller.set('public-internet'));
  t.is(f.stops(), 1);
  await t.throwsAsync(controller.forTurn(), { message: /uncertain/ });
  t.is(await f.create().forTurn(), 'public-internet');
});
