// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeAdapterKeeper } from '../src/adapter-keeper.js';
import { make as makeHttp } from '../resources/http/durable.js';

// A deterministic adapter double isolates manager ordering from real sockets;
// http-integration.test.js covers the installed package in a native process.
const fixture = (failClose = false, failBind = false) => {
  const bound = new Map();
  let binds = 0;
  const adapter = Far('Adapter', {
    bind: (port, handler) => {
      if (failBind) throw Error('Port unavailable');
      bound.set(port, handler);
      binds += 1;
    },
    unbind: port => {
      if (failClose) {
        failClose = false;
        throw Error('Close interrupted');
      }
      return bound.delete(port);
    },
    restore: entries => {
      if (failBind) return;
      for (const [port, handler] of entries) bound.set(port, handler);
    },
    ports: () => harden([...bound.keys()]),
  });
  const adapters = Far('Launcher', {
    create: () =>
      Far('Incarnation', {
        getRoot: () => adapter,
        retire: () => bound.clear(),
      }),
  });
  const kit = makeHttp({ E, Far, makeKeeper: makeAdapterKeeper, adapters });
  return {
    kit,
    bound,
    binds: () => binds,
    allowBind: () => {
      failBind = false;
    },
  };
};

test('HTTP registration keeps private lifecycle separate and closes only its own generation', async t => {
  const { kit, bound } = fixture();
  const handler = Far('Handler', {
    handle: () => harden({ status: 200, body: 'ok' }),
  });
  const first = await E(kit.registration).register(18_080, handler);
  t.is((await E(first).status()).status, 'listening');
  t.true(await E(first).close());
  const second = await E(kit.registration).register(18_080, handler);
  t.false(await E(first).close());
  t.true(bound.has(18_080));
  t.is((await E(second).status()).status, 'listening');
  t.is((await E(first).status()).status, 'closed');
  t.true(await E(second).close());
});

test('HTTP startup reconciliation and registration share one ordered desired set', async t => {
  const { kit, bound } = fixture();
  const handler = Far('Handler', {});
  const registration = await E(kit.registration).register(18_080, handler);
  await Promise.all([
    E(kit.lifecycle).started(),
    E(registration).close(),
    E(kit.lifecycle).started(),
  ]);
  t.false(bound.has(18_080));
  await E(kit.lifecycle).started();
  t.false(bound.has(18_080));
});

test('an interrupted close retires the adapter before another registration is served', async t => {
  const { kit, bound } = fixture(true);
  const handler = Far('Handler', {});
  const first = await E(kit.registration).register(18_080, handler);
  const second = await E(kit.registration).register(18_081, handler);
  await t.throwsAsync(() => E(first).close(), { message: /Close interrupted/ });
  t.false(bound.has(18_080));
  t.is((await E(second).status()).status, 'listening');
  t.false(bound.has(18_080));
});

test.serial(
  'restoring an occupied port preserves other HTTP listeners',
  async t => {
    t.timeout(10_000);
    const { createServer } = await import('node:net');
    const { make: makeAdapter } =
      await import('../resources/http/ephemeral.js');
    const occupied = createServer();
    t.teardown(() => occupied.close());
    const reserve = async server => {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    };
    const blocked = await reserve(occupied);
    const temporary = createServer();
    t.teardown(() => temporary.close());
    const available = await reserve(temporary);
    await new Promise(resolve => temporary.close(resolve));
    const adapter = makeAdapter();
    t.teardown(() => E(adapter).unbind(available));
    const handler = Far('Handler', {
      handle: () => harden({ status: 200, body: 'ok' }),
    });
    const results = await E(adapter).restore(
      harden([
        [blocked, handler, {}],
        [available, handler, {}],
      ]),
    );
    t.is(results[0].port, blocked);
    t.regex(results[0].error, /EADDRINUSE/);
    t.deepEqual(await E(adapter).ports(), [available]);
  },
);

test('invalid HTTP policy does not consume a registration', async t => {
  const { kit } = fixture();
  const handler = Far('Handler', {});
  await t.throwsAsync(
    () => E(kit.registration).register(18_080, handler, { origins: 7 }),
    { message: /origins must be an array/ },
  );
  const registration = await E(kit.registration).register(18_080, handler);
  t.is((await E(registration).status()).status, 'listening');
});

test('a failed initial bind still returns a handle that can cancel or retry', async t => {
  const { kit, bound, allowBind } = fixture(false, true);
  const handler = Far('Handler', {});
  const cancelled = await E(kit.registration).register(18_080, handler);
  t.like(await E(cancelled).status(), {
    status: 'inactive',
    error: 'Port unavailable',
  });
  t.true(await E(cancelled).close());
  const retried = await E(kit.registration).register(18_081, handler);
  allowBind();
  await E(kit.lifecycle).started();
  t.false(bound.has(18_080));
  t.is((await E(retried).status()).status, 'listening');
  t.true(await E(retried).close());
});
