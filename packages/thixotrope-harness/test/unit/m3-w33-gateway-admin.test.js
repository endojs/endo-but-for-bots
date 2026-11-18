// @ts-check
// The gateway's manager side (M3 W3.3; designs/m3-interfaces.md 3.1, 7,
// hotspots H2 and H3): `AgentHostAdmin.gateway()` answers one
// `GatewayAdmin`; serve, replace, status before and after attach, a retired
// ops facet, rotate without ops, stop; and `makeAttach` handing the
// `gateway` key to its binding while refusing keys it has none for.
//
// The manager vat (`durable.js`) runs in Node over the real manager kit and
// adapter keeper of `@endo/thixotrope` (read by relative path: they are not
// exported) and the real adapter kit, whose author verbs are the real
// `makeAttach` with a fake gateway binding standing in for W3.7's
// `makeGatewayService`. A restart retires the incarnation the way a
// SIGKILL does: every call on it breaks with the hub's retired text, so the
// keeper's probe fails and the next provide builds and restores.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';
import { makeAdapter } from '@endo/thixotrope/native-adapter.js';

/* eslint-disable import/no-relative-packages */
import { makeManager as makeManagerKit } from '../../../thixotrope/src/native/manager-kit.js';
import { makeAdapterKeeper } from '../../../thixotrope/src/adapter-keeper.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import {
  GATEWAY_KEY,
  m3Texts,
  m3TextOf,
} from '../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import { make as makeManagerVat } from '../../resources/agent-host/durable.js';
import {
  SERVICE_KEY,
  makeAttach,
} from '../../resources/agent-host/impl/attach.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const operator = Far('Operator', {});

/**
 * @param {number} port
 * @param {Record<string, unknown>} [more]
 */
const configOf = (port, more = {}) => harden({ operator, port, ...more });

/**
 * A daemon in miniature: the manager vat over the real kit; each adapter
 * incarnation is the real adapter kit over the real `makeAttach`, with a
 * fake gateway binding (bind: listen, attach `GatewayOps`; unbind: close).
 */
const makeDaemon = () => {
  /** @type {string[]} */
  const log = [];
  let incarnations = 0;
  let failBind = false;
  let rotations = 0;
  /** @type {{ dead: boolean, connections: number } | undefined} */
  let current;

  const retiredGuard = (/** @type {{ dead: boolean }} */ life) => {
    if (life.dead) throw Error(HUB_RETIRED_MESSAGE);
  };

  const create = () => {
    incarnations += 1;
    const n = incarnations;
    const life = { dead: false, connections: 0 };
    current = life;
    const gatewayBinding = harden({
      /** @param {any} spec */
      bind: async spec => {
        retiredGuard(life);
        if (failBind) throw Error('listen EADDRINUSE: address in use');
        const { port } = spec.config;
        log.push(`bind ${n} port ${port}`);
        const status = harden({
          state: 'serving',
          port,
          origin: `http://127.0.0.1:${port}`,
          connections: 0,
          since: n,
        });
        const ops = Far('GatewayOps', {
          status: () => {
            retiredGuard(life);
            return harden({ ...status, connections: life.connections });
          },
          rotateSignIn: async () => {
            retiredGuard(life);
            rotations += 1;
            log.push(`rotate ${n}`);
          },
        });
        await E(spec.sink).attach(ops, status);
      },
      unbind: () => {
        log.push(`unbind ${n}`);
      },
    });
    const agentHostOps = Far('AgentHostOps', {
      live: () => {
        retiredGuard(life);
        return Far('Live', {});
      },
    });
    const { bind, unbind } = makeAttach({
      ops: agentHostOps,
      incarnation: `fake-${n}`,
      bindings: { [GATEWAY_KEY]: gatewayBinding },
    });
    /** @type {any} */
    const inner = makeAdapter({ label: 'AgentHost', bind, unbind });
    // A retired incarnation breaks every call, the keeper's probe included.
    const adapter = harden({
      /** @param {any[]} args */
      bind: (...args) => {
        retiredGuard(life);
        return /** @type {any} */ (E(inner)).bind(...args);
      },
      /** @param {any[]} args */
      unbind: (...args) => {
        retiredGuard(life);
        return /** @type {any} */ (E(inner)).unbind(...args);
      },
      /** @param {any[]} args */
      restore: (...args) => {
        retiredGuard(life);
        log.push(`restore ${n}`);
        return /** @type {any} */ (E(inner)).restore(...args);
      },
      __getMethodNames__: () => {
        retiredGuard(life);
        return harden(['bind', 'unbind', 'restore']);
      },
    });
    return Far('Incarnation', {
      getRoot: () => adapter,
      retire: () => {
        life.dead = true;
      },
    });
  };

  /** @type {any} */
  let kit;
  const vat = makeManagerVat({
    makeManager: options => {
      kit = makeManagerKit(
        {
          adapters: Far('Launcher', { create }),
          makeKeeper: makeAdapterKeeper,
        },
        options,
      );
      return kit;
    },
  });
  return {
    facet: vat.facet,
    lifecycle: vat.lifecycle,
    kit: () => kit,
    log,
    incarnations: () => incarnations,
    rotations: () => rotations,
    setFailBind: (/** @type {boolean} */ value) => {
      failBind = value;
    },
    setConnections: (/** @type {number} */ value) => {
      if (current) current.connections = value;
    },
    /** The adapter process dies (SIGKILL): its objects are tombstones. */
    kill: () => {
      if (current) current.dead = true;
    },
  };
};

test('AgentHostAdmin.gateway() answers one GatewayAdmin for the life of the manager', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  t.is(await E(daemon.facet).gateway(), admin);
  t.deepEqual(await E(admin).status(), { state: 'stopped' });
});

test('serve registers the config, answers the attached status; status forwards to ops', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  const served = await E(admin).serve(configOf(8930));
  t.deepEqual(served, {
    state: 'serving',
    port: 8930,
    origin: 'http://127.0.0.1:8930',
    connections: 0,
    since: 1,
  });
  t.deepEqual(daemon.kit().keys(), [GATEWAY_KEY]);
  daemon.setConnections(3);
  t.like(await E(admin).status(), { state: 'serving', connections: 3 });
  // The first incarnation restores what is desired: the key just registered.
  t.deepEqual(daemon.log, ['restore 1', 'bind 1 port 8930']);
});

test('serve again replaces: the old binding is released, the new config bound', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  await E(admin).serve(configOf(8930));
  const again = await E(admin).serve(
    configOf(8931, { publicOrigin: 'http://127.0.0.1:8931' }),
  );
  t.like(again, { state: 'serving', port: 8931 });
  t.deepEqual(daemon.log, [
    'restore 1',
    'bind 1 port 8930',
    'unbind 1',
    'bind 1 port 8931',
  ]);
  t.deepEqual(daemon.kit().keys(), [GATEWAY_KEY]);
  t.like(await E(admin).status(), { port: 8931 });
});

test('stop closes the registration and forgets it; status is stopped', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  await E(admin).serve(configOf(8930));
  t.is(await E(admin).stop(), undefined);
  t.deepEqual(daemon.log, ['restore 1', 'bind 1 port 8930', 'unbind 1']);
  t.deepEqual(daemon.kit().keys(), []);
  t.deepEqual(await E(admin).status(), { state: 'stopped' });
  // A second stop is harmless.
  t.is(await E(admin).stop(), undefined);
  await t.throwsAsync(() => E(admin).rotateSignIn(), {
    message: m3Texts.gatewayNotAttached,
  });
});

test('a bind that fails answers failed with the fixed text; stop withdraws it', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  daemon.setFailBind(true);
  const served = await E(admin).serve(configOf(8930));
  t.is(served.state, 'failed');
  t.true(
    served.error.startsWith(m3TextOf.gatewayFailed('')),
    'the fixed text first',
  );
  t.regex(served.error, /EADDRINUSE/);
  t.deepEqual(await E(admin).status(), served, 'status keeps the failure');
  await t.throwsAsync(() => E(admin).rotateSignIn(), {
    message: m3Texts.gatewayNotAttached,
  });
  t.deepEqual(daemon.kit().keys(), [GATEWAY_KEY], 'still desired');
  await E(admin).stop();
  t.deepEqual(daemon.kit().keys(), []);
  // The next serve binds once the listener can.
  daemon.setFailBind(false);
  t.like(await E(admin).serve(configOf(8930)), { state: 'serving' });
});

test('the config guard refuses an extra key, an oversize origin and too many proxies', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  await t.throwsAsync(() => E(admin).serve(configOf(8930, { host: 'x' })));
  await t.throwsAsync(() =>
    E(admin).serve(configOf(8930, { publicOrigin: 'h'.repeat(2049) })),
  );
  await t.throwsAsync(() =>
    E(admin).serve(
      configOf(8930, {
        trustedProxies: Array.from({ length: 17 }, () => '127.0.0.1'),
      }),
    ),
  );
  await t.throwsAsync(() => E(admin).serve(configOf(65_536)));
  t.deepEqual(daemon.log, [], 'nothing reached the kit');
});

test('a restart: retired ops answer starting; the restore re-attaches with the same config', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  await E(admin).serve(configOf(8930));
  daemon.kill();
  t.deepEqual(await E(admin).status(), { state: 'starting' });
  // The daemon start: the kit rebuilds and restores every desired key.
  await E(daemon.lifecycle).started();
  t.is(daemon.incarnations(), 2);
  t.like(await E(admin).status(), { state: 'serving', port: 8930, since: 2 });
  t.deepEqual(daemon.log, [
    'restore 1',
    'bind 1 port 8930',
    'restore 2',
    'bind 2 port 8930',
  ]);
  await E(admin).rotateSignIn();
  t.deepEqual(daemon.log.at(-1), 'rotate 2');
});

test('rotateSignIn forwards; on a retired ops facet it reconciles once and rotates on the new one', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  await t.throwsAsync(() => E(admin).rotateSignIn(), {
    message: m3Texts.gatewayNotAttached,
  });
  await E(admin).serve(configOf(8930));
  t.is(await E(admin).rotateSignIn(), undefined);
  t.is(daemon.rotations(), 1);
  daemon.kill();
  await E(admin).rotateSignIn();
  t.is(daemon.rotations(), 2);
  t.is(daemon.incarnations(), 2);
  t.deepEqual(daemon.log.slice(-3), [
    'restore 2',
    'bind 2 port 8930',
    'rotate 2',
  ]);
});

test('both keys of the resource restore together; makeAttach hands each to its own binding', async t => {
  const daemon = makeDaemon();
  const admin = await E(daemon.facet).gateway();
  await E(admin).serve(configOf(8930));
  // An agent-host call registers the service key on the same incarnation.
  await E(daemon.facet).live();
  t.deepEqual(daemon.kit().keys(), [GATEWAY_KEY, SERVICE_KEY]);
  daemon.kill();
  await E(daemon.lifecycle).started();
  t.like(await E(admin).status(), { state: 'serving', since: 2 });
  t.truthy(await E(daemon.facet).live(), 'the agent host re-attached too');
  t.is(daemon.incarnations(), 2);
});

test('makeAttach refuses a key with no binding, binds the service key as before', async t => {
  /** @type {any[]} */
  const attached = [];
  /** @type {string[]} */
  const calls = [];
  const sink = Far('AgentHostSink', {
    /** @param {any[]} args */
    attach: (...args) => {
      attached.push(args);
      return attached.length;
    },
  });
  const ops = Far('AgentHostOps', {});
  const { bind, unbind } = makeAttach({
    ops,
    incarnation: 'i1',
    bindings: {
      [GATEWAY_KEY]: {
        bind: spec => {
          calls.push(`bind ${spec.config.port}`);
        },
        unbind: () => {
          calls.push('unbind');
        },
      },
    },
  });
  await t.throwsAsync(() => bind('elsewhere', harden({})), {
    message: 'agent host has no registration "elsewhere"',
  });
  await t.throwsAsync(() => bind('toString', harden({})), {
    message: 'agent host has no registration "toString"',
  });
  const binding = await bind(SERVICE_KEY, harden({ sink }));
  t.deepEqual(binding, { key: SERVICE_KEY });
  t.deepEqual(attached, [[ops, 'i1']]);
  const gatewayBinding = await bind(
    GATEWAY_KEY,
    harden({ sink, config: { port: 1 } }),
  );
  t.deepEqual(gatewayBinding, { key: GATEWAY_KEY });
  await unbind(gatewayBinding, GATEWAY_KEY);
  await unbind(binding, SERVICE_KEY);
  t.deepEqual(calls, ['bind 1', 'unbind']);
  // Without bindings (M2's callers) every other key is refused.
  const plain = makeAttach({ ops, incarnation: 'i2' });
  await t.throwsAsync(() => plain.bind(GATEWAY_KEY, harden({})), {
    message: 'agent host has no registration "gateway"',
  });
});
