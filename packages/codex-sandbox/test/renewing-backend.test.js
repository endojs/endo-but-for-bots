// @ts-check
import '@endo/init';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeRenewingCodexBackend } from '../src/renewing-backend.js';

const fixture = () => {
  const events = [];
  let count = 0;
  let active = false;
  let pendingToolCalls = 0;
  let failCleanup = false;
  let failSend = false;
  let checkpoint = 'initial';
  let blockCreate;
  let blockSend;
  const inner = Far('Factory', {
    async create(spec, tools) {
      events.push(['create', spec.sessionId, tools]);
      if (blockCreate) await blockCreate;
      if (failCleanup) throw Error('reap failed');
      count += 1;
      const generation = count;
      events.push(['loaded', checkpoint]);
      return harden({
        run: Far('Run', {
          async send(prompt) {
            events.push(['send', generation, prompt]);
            if (blockSend) await blockSend;
            if (failSend) throw Error('dispatched failure');
            active = true;
            return harden({ generation });
          },
          async status() {
            return harden({ active, pendingToolCalls });
          },
          async acknowledge(value) {
            checkpoint = value;
          },
          async interrupt() {
            events.push(['interrupt', generation]);
            active = false;
          },
        }),
        admin: Far('Admin', {
          async terminate() {
            events.push(['stop', generation]);
          },
        }),
      });
    },
    async listModels() {
      return harden([]);
    },
    async describe() {
      return harden({});
    },
    async destroy() {
      if (failCleanup) throw Error('destroy reap failed');
      events.push(['destroy']);
    },
  });
  return {
    factory: makeRenewingCodexBackend(inner),
    tools: Far('Tools', {}),
    events,
    setActive: value => {
      active = value;
    },
    setPending: value => {
      pendingToolCalls = value;
    },
    setCleanupFailure: value => {
      failCleanup = value;
    },
    setSendFailure: value => {
      failSend = value;
    },
    setBlock: value => {
      blockCreate = value;
    },
    setSendBlock: value => {
      blockSend = value;
    },
  };
};

test('each turn loads a fresh generation after forwarding the durable acknowledgement', async t => {
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  t.deepEqual(await E(session.run).send('first'), { generation: 2 });
  f.setActive(false);
  await E(session.run).acknowledge('checkpoint-one');
  t.deepEqual(await E(session.run).send('second'), { generation: 3 });
  t.true(
    f.events.some(
      event => event[0] === 'loaded' && event[1] === 'checkpoint-one',
    ),
  );
  t.true(
    f.events
      .filter(event => event[0] === 'create')
      .every(event => event[2] === f.tools),
  );
  await E(session.admin).terminate();
  t.deepEqual(f.events.at(-1), ['stop', 3]);
});

test('active turns and unsettled tools prohibit renewal without cleanup or dispatch', async t => {
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  f.setActive(true);
  await t.throwsAsync(E(session.run).send('blocked'), {
    message: /previous turn/,
  });
  f.setActive(false);
  f.setPending(1);
  await t.throwsAsync(E(session.run).send('blocked'), { message: /unsettled/ });
  t.is(f.events.filter(event => event[0] === 'create').length, 1);
});

test('cleanup failure prevents dispatch; a dispatched failure is not retried', async t => {
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  f.setCleanupFailure(true);
  await t.throwsAsync(E(session.run).send('blocked'), {
    message: /reap failed/,
  });
  t.is(f.events.filter(event => event[0] === 'send').length, 0);
  f.setCleanupFailure(false);
  f.setSendFailure(true);
  await t.throwsAsync(E(session.run).send('once'), {
    message: /dispatched failure/,
  });
  t.is(f.events.filter(event => event[0] === 'send').length, 1);
});

test('superseded run and admin cannot affect the successor', async t => {
  const f = fixture();
  const first = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  const next = await E(f.factory).create(harden({ sessionId: 'one' }), f.tools);
  await E(first.admin).terminate();
  t.false(f.events.some(event => event[0] === 'stop'));
  await t.throwsAsync(E(first.run).send('stale'), { message: /superseded/ });
  await E(next.run).send('current');
  await E(f.factory).destroy(harden({ sessionId: 'one' }));
  await t.throwsAsync(E(next.run).send('destroyed'), { message: /superseded/ });
});

test('concurrent sends cannot enqueue an automatic second turn during renewal', async t => {
  t.timeout(5000);
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  let unblock = () => {};
  f.setBlock(
    new Promise(resolve => {
      unblock = () => resolve(undefined);
    }),
  );
  const first = E(session.run).send('first');
  await t.throwsAsync(E(session.run).send('second'), { message: /admission/ });
  unblock();
  await first;
  t.is(f.events.filter(event => event[0] === 'send').length, 1);
});

test('failed handover retains the predecessor cleanup authority', async t => {
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  f.setCleanupFailure(true);
  await t.throwsAsync(
    E(f.factory).create(harden({ sessionId: 'one' }), f.tools),
    { message: /reap failed/ },
  );
  await E(session.admin).terminate();
  t.deepEqual(f.events.at(-1), ['stop', 1]);
});

test('failed destroy retains the same admin cleanup authority', async t => {
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  f.setCleanupFailure(true);
  await t.throwsAsync(E(f.factory).destroy(harden({ sessionId: 'one' })), {
    message: /destroy reap failed/,
  });
  f.setCleanupFailure(false);
  await E(session.admin).terminate();
  t.deepEqual(f.events.at(-1), ['stop', 1]);
});

test('interrupt during provisioning prevents dispatch of the canceled prompt', async t => {
  t.timeout(5000);
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  let unblock = () => {};
  f.setBlock(
    new Promise(resolve => {
      unblock = () => resolve(undefined);
    }),
  );
  t.teardown(unblock);
  const sending = E(session.run).send('must not dispatch');
  // status is not lifecycle-queued, so this observes admission in progress.
  t.true((await E(session.run).status()).renewing);
  const interrupted = E(session.run).interrupt();
  const rejected = t.throwsAsync(sending, {
    message: /interrupted before dispatch/,
  });
  await E(session.run).status();
  unblock();
  await interrupted;
  await rejected;
  t.is(f.events.filter(event => event[0] === 'send').length, 0);
});

test('interrupt reaches the current client while send startup is blocked', async t => {
  t.timeout(5000);
  const f = fixture();
  const session = await E(f.factory).create(
    harden({ sessionId: 'one' }),
    f.tools,
  );
  let unblock = () => {};
  f.setSendBlock(
    new Promise(resolve => {
      unblock = () => resolve(undefined);
    }),
  );
  t.teardown(unblock);
  const sending = E(session.run).send('slow startup');
  while (!f.events.some(event => event[0] === 'send')) {
    // eslint-disable-next-line no-await-in-loop
    await E(session.run).status();
  }
  const interrupted = E(session.run).interrupt();
  while (!f.events.some(event => event[0] === 'interrupt')) {
    // eslint-disable-next-line no-await-in-loop
    await E(session.run).status();
  }
  t.deepEqual(f.events.at(-1), ['interrupt', 2]);
  unblock();
  await sending;
  await interrupted;
});
