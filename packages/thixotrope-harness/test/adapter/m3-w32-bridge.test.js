// @ts-check
// M3 W3.2: the gateway's CapTP bridge, guard and bootstrap
// (resources/agent-host/impl/gateway/{bridge,guard,powers}.js;
// designs/m3-interfaces.md 4.2-4.5). Node only, over an in-memory socket
// pair; `Far` objects stand in for vat presences.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { m3Texts } from '../../guest/lib/interfaces-m3.js';
import { limits as guestLimits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  closeCodes,
  gatewayLimits,
  gatewayTexts,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeBridge } from '../../resources/agent-host/impl/gateway/bridge.js';
import { checkCall } from '../../resources/agent-host/impl/gateway/guard.js';
import { makeBootstrapFactory } from '../../resources/agent-host/impl/gateway/powers.js';
import { harnessNames } from '../../resources/agent-host/impl/gateway/vocabulary.js';
import { makeClient } from './_m3-captp-client.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

// A sign-in value built at run time (64 hex digits, not a real secret).
const SECRET = ['0123456789abcdef'].join('').repeat(4);
const { keys: vocabulary, methods: contractMethods } = harnessNames({
  log: () => {},
});
// The stand-ins' test-only methods (not in any contract interface).
const testOnlyMethods = ['hang', 'many'];
const methods = new Set([...contractMethods, ...testOnlyMethods]);

const tick = () => new Promise(resolve => setImmediate(resolve));

/** The vat stand-ins and gateway-local objects of one test. */
const makeWorld = () => {
  /** @type {any[][]} */
  const calls = [];
  /** @type {(() => void)[]} */
  const hanging = [];
  const turn = Far('Turn', {
    getStatus: () => harden({ state: 'running' }),
  });
  const session = Far('Session', {
    getInfo: () => {
      calls.push(['getInfo']);
      return harden({ title: 'New chat', turn, turns: [turn, turn] });
    },
    /** @param {unknown} title */
    rename: title => {
      calls.push(['rename', title]);
    },
    /** @param {unknown} cursor */
    getHistoryPage: cursor => {
      calls.push(['getHistoryPage', cursor]);
      return harden({ records: [] });
    },
    hang: () =>
      new Promise(resolve => {
        hanging.push(() => resolve(undefined));
      }),
    /** @param {number} count */
    many: count =>
      harden(Array.from({ length: count }, (_, i) => Far(`Thing${i % 2}`, {}))),
  });
  const factory = Far('SessionFactory', {
    /** @param {unknown} options */
    listSessions: options => {
      calls.push(['listSessions', options]);
      return harden({ rows: [harden({ session, title: 'New chat' })] });
    },
    findSession: () => session,
    /** @param {unknown} options */
    createSession: options => {
      calls.push(['createSession', options]);
      return session;
    },
  });
  const operator = Far('Operator', { getFactory: () => factory });
  /** @type {any[]} */
  const innerClosed = [];
  /** @param {string} label */
  const makeInnerSubscription = label => {
    const inner = Far(label, {
      next: async () =>
        harden(
          label === 'LiveSubscription'
            ? { rev: 1, deliveries: [] }
            : { rev: 1, events: [] },
        ),
      close: () => {
        innerClosed.push(inner);
      },
    });
    return inner;
  };
  const live = Far('Live', {
    subscribe: () => makeInnerSubscription('LiveSubscription'),
    subscribeList: () => makeInnerSubscription('ListSubscription'),
  });
  const composer = Far('Composer', {
    /**
     * @param {unknown} s
     * @param {string} text
     * @param {string} requestId
     */
    submit: (s, text, requestId) => {
      calls.push(['submit', text.length, requestId]);
      return harden({ requestId, duplicate: false });
    },
  });
  const content = Far('Content', { read: () => 'text' });
  const history = Far('History', { page: () => harden({ turns: [] }) });
  const extra = Far('FixtureService', { ping: () => 'pong' });
  /** @type {string[]} */
  const limiterLog = [];
  /** @type {Set<string>} */
  const blocked = new Set();
  const limiter = {
    /** @param {string} address */
    check: address =>
      blocked.has(address)
        ? { ok: /** @type {const} */ (false), text: 'blocked for the test' }
        : { ok: /** @type {const} */ (true) },
    /** @param {string} address */
    failed: address => {
      limiterLog.push(`failed ${address}`);
    },
    /** @param {string} address */
    succeeded: address => {
      limiterLog.push(`succeeded ${address}`);
    },
  };
  /** @type {string[]} */
  const compared = [];
  const signIn = {
    /** @param {string} candidate */
    matches: candidate => {
      compared.push(candidate === SECRET ? 'right' : 'wrong');
      return candidate === SECRET;
    },
  };
  const makeBootstrap = makeBootstrapFactory({
    signIn,
    limiter,
    operator,
    live,
    content,
    composer,
    history: () => history,
    extras: [{ label: 'fixture', service: extra }],
  });
  return {
    calls,
    hanging,
    session,
    factory,
    operator,
    composer,
    innerClosed,
    limiterLog,
    blocked,
    compared,
    makeBootstrap,
  };
};

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @param {object} [options]
 * @param {Partial<import('../../resources/agent-host/impl/gateway/bridge.js').BridgeLimits>} [options.limits]
 * @param {string} [options.address]
 */
const connect = (world, { limits, address = '127.0.0.1' } = {}) => {
  /** @type {Record<string, unknown>[]} */
  const logged = [];
  const bridge = makeBridge({
    makeBootstrap: world.makeBootstrap,
    vocabulary,
    methods,
    isLargeCall: (target, method) =>
      target === world.composer && (method === 'submit' || method === 'edit'),
    limits,
    log: event => logged.push(event),
  });
  /** @type {((bytes: Uint8Array | string) => void) | undefined} */
  let toServer;
  /** @type {(() => void) | undefined} */
  let serverClosed;
  /** @type {{ code: number, reason: string }[]} */
  const closes = [];
  /** @type {any[]} */
  const received = [];
  let clientGone = false;
  const client = makeClient({
    send: bytes =>
      setImmediate(() => {
        if (!clientGone) toServer?.(bytes);
      }),
    onClose: () => {
      if (!clientGone) {
        clientGone = true;
        serverClosed?.();
      }
    },
  });
  const socket = {
    address,
    /** @param {Uint8Array} bytes */
    send: bytes =>
      setImmediate(() => {
        received.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
        client.receive(bytes);
      }),
    /**
     * @param {number} code
     * @param {string} reason
     */
    close: (code, reason) => {
      closes.push({ code, reason });
      clientGone = true;
      client.close();
    },
    /** @param {(bytes: Uint8Array | string) => void} handler */
    onMessage: handler => {
      toServer = handler;
    },
    /** @param {() => void} handler */
    onClose: handler => {
      serverClosed = handler;
    },
  };
  const connection = bridge.connect(socket);
  /** @param {Uint8Array | string} frame */
  const sendFrame = frame => toServer?.(frame);
  return { bridge, client, connection, closes, received, logged, sendFrame };
};

/**
 * @param {ReturnType<typeof connect>} pair
 * @returns {Promise<any>}
 */
const signIn = async pair => E(pair.client.bootstrap()).fetch(SECRET);

test('fetch: wrong secret refused and penalised, right one gives powers', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const bootstrap = pair.client.bootstrap();
  await t.throwsAsync(() => E(bootstrap).fetch('nope'), {
    message: m3Texts.signInRefused,
  });
  t.deepEqual(world.limiterLog, ['failed 127.0.0.1']);
  const powers = await E(bootstrap).fetch(SECRET);
  t.deepEqual(Object.keys(powers).sort(), [
    'composer',
    'content',
    'extras',
    'history',
    'live',
    'operator',
  ]);
  t.is(powers.extras[0].label, 'fixture');
  t.is(await E(powers.extras[0].service).ping(), 'pong');
  const again = await E(bootstrap).fetch(SECRET);
  t.is(again.live, powers.live, 'a second fetch answers the same record');
  t.is(again.operator, powers.operator);
  t.deepEqual(world.limiterLog, [
    'failed 127.0.0.1',
    'succeeded 127.0.0.1',
    'succeeded 127.0.0.1',
  ]);
});

test('fetch: an address inside its penalty is refused before comparing', async t => {
  const world = makeWorld();
  world.blocked.add('192.0.2.7');
  const pair = connect(world, { address: '192.0.2.7' });
  await t.throwsAsync(() => signIn(pair), { message: 'blocked for the test' });
  t.deepEqual(world.compared, [], 'the secret was not compared');
});

test('before fetch only fetch is dispatched', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const bootstrap = pair.client.bootstrap();
  await t.throwsAsync(() => E(bootstrap).getFactory(), {
    message: gatewayTexts.notSignedIn,
  });
  await signIn(pair);
  // After sign-in the bootstrap's own guard answers for unknown methods.
  await t.throwsAsync(() => E(bootstrap).getFactory(), {
    message: /getFactory/,
  });
});

test('pass-through: calls, nested remotables and identity', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const page = await E(factory).listSessions({ limit: 5 });
  t.deepEqual(world.calls[0], ['listSessions', { limit: 5 }]);
  const { session } = page.rows[0];
  const again = await E(factory).findSession('k');
  t.is(again, session, 'one vat object is one presence on a connection');
  const info = await E(session).getInfo();
  t.is(info.turns[0], info.turn);
  t.deepEqual(await E(info.turn).getStatus(), { state: 'running' });
  // A presence passed back reaches the target as the same object.
  await E(powers.composer).submit(session, 'hello', 'request-1');
  t.deepEqual(world.calls.at(-1), ['submit', 5, 'request-1']);
  t.true(pair.connection.stats().exports > 5);
});

test('frame guard: over frameBytes refused unless a LargeCall', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const { session } = (await E(factory).listSessions()).rows[0];
  const big = 'x'.repeat(100 * 1024);
  const before = world.calls.length;
  await t.throwsAsync(() => E(session).rename(big), {
    message: gatewayTexts.messageTooLarge,
  });
  t.is(world.calls.length, before, 'nothing reached the target');
  const receipt = await E(powers.composer).submit(session, big, 'request-2');
  t.is(receipt.requestId, 'request-2');
  t.deepEqual(world.calls.at(-1), ['submit', big.length, 'request-2']);
  // Just under the bound passes.
  const fits = 'y'.repeat(guestLimits.frameBytes - 64);
  await E(session).rename(fits);
  t.deepEqual(world.calls.at(-1), ['rename', fits]);
});

test('key guard: invented keys refused, contract keys pass', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const invented = Object.fromEntries(
    Array.from({ length: 2000 }, (_, i) => [`k${i}`, 0]),
  );
  const before = world.calls.length;
  await t.throwsAsync(() => E(factory).createSession(harden(invented)), {
    message: gatewayTexts.unexpectedField,
  });
  await t.throwsAsync(
    () =>
      E(factory).createSession(
        harden({ title: 't', networkPolicy: harden({ madeUp: true }) }),
      ),
    { message: gatewayTexts.unexpectedField },
  );
  t.is(world.calls.length, before, 'nothing reached the factory');
  await E(factory).createSession(harden({ title: 'ok' }));
  t.deepEqual(world.calls.at(-1), ['createSession', { title: 'ok' }]);
  t.is(pair.connection.stats().refused, 2);
  const refusal = pair.logged.find(e => e.event === 'gateway-refused');
  t.like(refusal, { rule: 'keys', target: 'Alleged: SessionFactory' });
  t.false(JSON.stringify(pair.logged).includes('k1999'), 'no body is logged');
});

test('depth guard: 32 levels pass, 33 are refused', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const { session } = (await E(factory).listSessions()).rows[0];
  /** @param {number} levels */
  const nest = levels => {
    /** @type {any} */
    let value = 'leaf';
    for (let i = 0; i < levels; i += 1) value = harden([value]);
    return value;
  };
  await E(session).getHistoryPage(nest(32));
  t.is(world.calls.at(-1)?.[0], 'getHistoryPage');
  const before = world.calls.length;
  await t.throwsAsync(() => E(session).getHistoryPage(nest(33)), {
    message: gatewayTexts.tooDeep,
  });
  t.is(world.calls.length, before);
});

test('page objects and page promises are refused', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const { session } = (await E(factory).listSessions()).rows[0];
  const before = world.calls.length;
  await t.throwsAsync(() => E(session).rename(Far('PageThing', {})), {
    message: gatewayTexts.browserObject,
  });
  await t.throwsAsync(() => E(session).rename(new Promise(() => {})), {
    message: gatewayTexts.browserObject,
  });
  t.is(world.calls.length, before);
  await E(session).rename('still open');
  t.deepEqual(world.calls.at(-1), ['rename', 'still open']);
});

test('unknown targets and slots are refused; the connection stays open', async t => {
  const world = makeWorld();
  const pair = connect(world);
  await signIn(pair);
  const call = (/** @type {string} */ id, /** @type {string[]} */ slots) =>
    pair.sendFrame(
      Buffer.from(
        JSON.stringify({
          type: 'CTP_CALL',
          epoch: 0,
          questionID: id,
          target: 'o-999',
          method: { body: JSON.stringify(['getInfo', []]), slots },
        }),
      ),
    );
  call('q-9001', []);
  await tick();
  await tick();
  const answer = pair.received.find(m => m.answerID === 'q-9001');
  t.truthy(answer?.exception);
  t.regex(answer.exception.body, new RegExp(gatewayTexts.notSignedIn));
  t.deepEqual(pair.closes, []);
});

test('calls in flight: 32 to vat targets, the 33rd refused, local ones pass', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const { session } = (await E(factory).listSessions()).rows[0];
  const waiting = Array.from({ length: gatewayLimits.callsInFlight }, () =>
    E(session).hang(),
  );
  while (world.hanging.length < gatewayLimits.callsInFlight) {
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  t.is(pair.connection.stats().inFlight, gatewayLimits.callsInFlight);
  await t.throwsAsync(() => E(session).getInfo(), {
    message: gatewayTexts.tooManyCalls,
  });
  // Gateway-local objects do not count.
  const subscription = await E(powers.live).subscribe(session);
  t.deepEqual(await E(subscription).next(), { rev: 1, deliveries: [] });
  for (const release of world.hanging) release();
  await Promise.all(waiting);
  t.is(pair.connection.stats().inFlight, 0);
  t.is((await E(session).getInfo()).title, 'New chat');
});

test('protocol: text frames, bad UTF-8 and bad JSON close the connection', async t => {
  for (const frame of [
    'text frame',
    Buffer.from([0xff, 0xfe, 0x7b]),
    Buffer.from('{"type":'),
    Buffer.from('{"type":"CTP_NOPE"}'),
  ]) {
    const pair = connect(makeWorld());
    pair.sendFrame(frame);
    t.deepEqual(
      pair.closes.map(c => c.code),
      [closeCodes.protocol],
    );
    t.is(pair.bridge.connections(), 0);
  }
});

test('sign-in deadline closes a connection that has not signed in', async t => {
  const world = makeWorld();
  const slow = connect(world, { limits: { signInDeadlineMs: 30 } });
  const quick = connect(world, { limits: { signInDeadlineMs: 30 } });
  await signIn(quick);
  await new Promise(resolve => setTimeout(resolve, 80));
  t.deepEqual(
    slow.closes.map(c => c.code),
    [closeCodes.signInDeadline],
  );
  t.deepEqual(quick.closes, []);
});

test('exports cap: more than exportsPerConnection closes the connection', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const { session } = (await E(factory).listSessions()).rows[0];
  const held = pair.connection.stats().exports;
  const result = E(session).many(gatewayLimits.exportsPerConnection - held);
  await result;
  t.deepEqual(pair.closes, []);
  const over = E(session).many(1);
  await t.throwsAsync(() => over);
  t.deepEqual(
    pair.closes.map(c => c.code),
    [closeCodes.tooManyObjects],
  );
});

test('CTP_DROP releases an export; a later call on it is refused', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const before = pair.connection.stats().exports;
  // The factory was the latest export: o+<before> in the gateway's naming.
  const slot = `o-${before}`;
  pair.sendFrame(
    Buffer.from(
      JSON.stringify({ type: 'CTP_DROP', slotID: slot, decRefs: 1000 }),
    ),
  );
  await tick();
  t.is(pair.connection.stats().exports, before - 1);
  await t.throwsAsync(() => E(factory).listSessions(), {
    message: gatewayTexts.notSignedIn,
  });
});

test('subscriptions are closed when the connection closes', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const { session } = (await E(factory).listSessions()).rows[0];
  const first = await E(powers.live).subscribe(session, 3);
  const second = await E(powers.live).subscribe(session);
  const list = await E(powers.live).subscribeList();
  await E(first).close();
  t.is(world.innerClosed.length, 1, 'a page close reaches the channel');
  t.true(second !== undefined && list !== undefined);
  pair.client.close();
  await tick();
  t.is(world.innerClosed.length, 3, 'the rest close with the connection');
  t.is(pair.bridge.connections(), 0);
});

test('closeAll closes every connection with the given code', async t => {
  const world = makeWorld();
  const pairA = connect(world);
  await signIn(pairA);
  pairA.bridge.closeAll(closeCodes.signInRotated, 'rotated');
  t.deepEqual(
    pairA.closes.map(c => c.code),
    [closeCodes.signInRotated],
  );
});

test('checkCall answers the text, or undefined to dispatch', t => {
  const value = Far('Session', {});
  const message = {
    type: 'CTP_CALL',
    questionID: 'q-1',
    target: 'o-1',
    method: {
      body: JSON.stringify(['rename', [{ unknownKey: 1 }]]),
      slots: [],
    },
  };
  const targetOf = (/** @type {string} */ id) =>
    id === 'o-1' ? { value, local: false } : undefined;
  t.is(
    checkCall({
      message,
      targetOf,
      vocabulary,
      methods,
      isLargeCall: () => false,
      inFlight: 0,
    }),
    gatewayTexts.unexpectedField,
  );
  const fine = {
    ...message,
    method: { body: JSON.stringify(['rename', ['title']]), slots: [] },
  };
  t.is(
    checkCall({
      message: fine,
      targetOf,
      vocabulary,
      methods,
      isLargeCall: () => false,
      inFlight: 0,
    }),
    undefined,
  );
});

test('M3-FIX: method names and symbols outside the contract are refused', async t => {
  const world = makeWorld();
  const pair = connect(world);
  const powers = await signIn(pair);
  const factory = await E(powers.operator).getFactory();
  const before = world.calls.length;
  // A fresh method name toward a vat target never reaches it.
  await t.throwsAsync(() => E(factory).inventedMethod0(), {
    message: gatewayTexts.unknownMethod,
  });
  // Nor through a pipelined answer.
  await t.throwsAsync(() => E(E(powers.operator).getFactory()).invented1(), {
    message: gatewayTexts.unknownMethod,
  });
  // A passable symbol argument with a fresh name.
  await t.throwsAsync(() => E(factory).listSessions(Symbol.for('freshName0')), {
    message: gatewayTexts.unknownMethod,
  });
  t.is(world.calls.length, before, 'nothing reached the target');
  t.true(
    pair.logged.some(e => e.event === 'gateway-refused' && e.rule === 'method'),
  );
  // Contract methods still pass, and the connection stays open.
  await E(factory).listSessions({ limit: 1 });
  t.deepEqual(world.calls.at(-1), ['listSessions', { limit: 1 }]);
  // Gateway-local objects keep their own guards' answer.
  await t.throwsAsync(() => E(powers.composer).inventedLocal(), {
    message: /inventedLocal/,
  });
});

test('M3-FIX: checkCall refuses encoded symbols and unknown names', t => {
  const value = Far('Session', {});
  const targetOf = (/** @type {string} */ id) =>
    id === 'o-1' ? { value, local: false } : undefined;
  /** @param {unknown[]} decoded */
  const call = decoded =>
    checkCall({
      message: {
        type: 'CTP_CALL',
        questionID: 'q-1',
        target: 'o-1',
        method: { body: JSON.stringify(decoded), slots: [] },
      },
      targetOf,
      vocabulary,
      methods,
      isLargeCall: () => false,
      inFlight: 0,
    });
  t.is(call(['rename', ['title']]), undefined);
  t.is(call(['renameX', ['title']]), gatewayTexts.unknownMethod);
  t.is(
    call([{ '@qclass': 'symbol', name: 'fresh' }, []]),
    gatewayTexts.unknownMethod,
  );
  t.is(
    call(['rename', [{ '@qclass': 'symbol', name: 'fresh' }]]),
    gatewayTexts.unknownMethod,
  );
  t.is(
    call(['rename', [[{ '@qclass': 'symbol', name: 'rename' }]]]),
    undefined,
    'a symbol naming a contract method is admitted',
  );
  t.is(call([null, []]), gatewayTexts.unknownMethod, 'no function call');
  t.is(call(['renameX']), gatewayTexts.unknownMethod, 'no property get');
});
