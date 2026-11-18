// @ts-check
/* eslint-disable import/no-relative-packages */
// The page's sign-in parameters and connection (m3-interfaces.md 9.2;
// R6-9..R6-14, D-17; W3.4): fragment parsing, the reconnect schedule with a
// fake clock, refused -> "Server starting...", a rejected fetch stops
// retrying, and the controller rebuilt after a reconnect.
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCapTP } from '@endo/captp';
import { E, Far } from '@endo/far';

import {
  isLoopbackGateway,
  parseLocation,
  socketUrl,
} from '../../ui/src/net/fragment.js';
import { makeConnection, reconnectDelay } from '../../ui/src/net/connection.js';
import { makeController } from '../../ui/src/controller/index.js';
import {
  WS_PATH,
  connectDeadlineMs,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeFakePowers } from './_m3-fake-powers.js';

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

test('fragment: sign-in parameters, query refusal, invalid gateways', t => {
  t.deepEqual(
    parseLocation({ hash: '#gateway=127.0.0.1:8920&agent=abc123', search: '' }),
    {
      gateway: '127.0.0.1:8920',
      agent: 'abc123',
    },
  );
  t.deepEqual(parseLocation({ hash: '#gateway=chat.invalid/&agent=x' }), {
    gateway: 'chat.invalid',
    agent: 'x',
  });
  t.deepEqual(parseLocation({ hash: '', search: '' }), {
    error: 'unconfigured',
  });
  t.deepEqual(parseLocation({ hash: '#agent=x' }), { error: 'unconfigured' });
  t.deepEqual(
    parseLocation({ hash: '#gateway=h&agent=x', search: '?agent=x' }),
    { error: 'query' },
    'R6-10: the query string is refused even with a fragment',
  );
  t.deepEqual(parseLocation({ search: '?gateway=h' }), { error: 'query' });
  t.deepEqual(parseLocation({ hash: '', search: '?page=2' }), {
    error: 'unconfigured',
  });
  for (const gateway of [
    'https://h',
    'h/path',
    'user@h',
    'h?x=1',
    'h x',
    'h:port',
    '',
    `${'a'.repeat(256)}`,
  ]) {
    t.deepEqual(
      parseLocation({
        hash: `#gateway=${encodeURIComponent(gateway)}&agent=x`,
      }),
      { error: 'invalid' },
      gateway,
    );
  }
  t.deepEqual(parseLocation({ hash: '#gateway=h&agent=a%20b' }), {
    error: 'invalid',
  });
  t.deepEqual(parseLocation({ hash: '#gateway=[::1]:80&agent=x' }), {
    gateway: '[::1]:80',
    agent: 'x',
  });
  t.true(isLoopbackGateway('127.0.0.1:1'));
  t.true(isLoopbackGateway('localhost'));
  t.true(isLoopbackGateway('[::1]:9'));
  t.false(isLoopbackGateway('chat.invalid'));
  t.is(socketUrl('127.0.0.1:5', WS_PATH), 'ws://127.0.0.1:5/ws');
  t.is(socketUrl('chat.invalid', WS_PATH), 'wss://chat.invalid/ws');
});

test('the R6-14 schedule: 0, 1, 2, 5, 10, 30 s, then every 30 s', t => {
  t.deepEqual(
    Array.from({ length: 9 }, (_, attempt) => reconnectDelay(attempt)),
    [0, 1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000, 30_000],
  );
});

const makeClock = () => {
  let time = 0;
  /** @type {Array<{ at: number, fn: () => void, id: number }>} */
  let pending = [];
  let next = 0;
  return {
    timers: {
      /**
       * @param {() => void} fn
       * @param {number} ms
       */
      setTimeout: (fn, ms) => {
        next += 1;
        pending.push({ at: time + ms, fn, id: next });
        return next;
      },
      /** @param {number} id */
      clearTimeout: id => {
        pending = pending.filter(entry => entry.id !== id);
      },
    },
    /** @param {number} ms */
    advance: ms => {
      const end = time + ms;
      for (;;) {
        const due = pending
          .filter(entry => entry.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending = pending.filter(entry => entry !== due);
        time = due.at;
        due.fn();
      }
      time = end;
    },
    now: () => time,
  };
};

/**
 * A fake WebSocket class whose server side is a CapTP connection answering
 * `fetch(secret)`; the test decides per socket whether it opens.
 *
 * @param {{ secret: string, powers: () => any }} server
 */
const makeSockets = ({ secret, powers }) => {
  /** @type {any[]} */
  const sockets = [];
  /** @type {string[]} */
  const fetched = [];
  class FakeSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'blob';
      /** @type {any} */
      this.onopen = undefined;
      /** @type {any} */
      this.onclose = undefined;
      /** @type {any} */
      this.onerror = undefined;
      /** @type {any} */
      this.onmessage = undefined;
      /** @type {any} */
      this.server = undefined;
      /** @type {number[]} */
      this.sentKinds = [];
      sockets.push(this);
    }

    /** Accept: open the socket and start the server's CapTP. */
    accept() {
      const bootstrap = Far('GatewayBootstrap', {
        /** @param {string} candidate */
        fetch: candidate => {
          fetched.push(candidate);
          if (candidate !== secret) throw Error('Sign-in refused');
          return powers();
        },
      });
      this.server = makeCapTP(
        'gateway',
        /** @param {any} message */
        message => {
          if (this.readyState !== 1) return;
          const bytes = new TextEncoder().encode(JSON.stringify(message));
          this.onmessage && this.onmessage({ data: bytes.buffer });
        },
        bootstrap,
      );
      this.readyState = 1;
      this.onopen && this.onopen();
    }

    /** Nothing listens: error and close without opening. */
    refuse() {
      this.readyState = 3;
      this.onerror && this.onerror({});
      this.onclose && this.onclose({ code: 1006 });
    }

    /** The connection drops. */
    drop() {
      this.readyState = 3;
      if (this.server) this.server.abort(Error('dropped'));
      this.onclose && this.onclose({ code: 1006 });
    }

    /** @param {Uint8Array} bytes */
    send(bytes) {
      this.sentKinds.push(bytes instanceof Uint8Array ? 1 : 0);
      const message = JSON.parse(new TextDecoder().decode(bytes));
      this.server.dispatch(message);
    }

    /** @param {number} [code] */
    close(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (this.server) this.server.abort(Error('closed'));
      this.onclose && this.onclose({ code });
    }
  }
  return { FakeSocket, sockets, fetched };
};

test('connect, drop, reconnect on the schedule; refused -> starting; deadline', async t => {
  const fake = makeFakePowers({ sessions: [{}] });
  const { FakeSocket, sockets } = makeSockets({
    secret: 'good',
    powers: () => fake.powers,
  });
  const clock = makeClock();
  /** @type {string[]} */
  const states = [];
  const connection = makeConnection({
    url: 'ws://127.0.0.1:1/ws',
    agent: 'good',
    WebSocket: FakeSocket,
    timers: clock.timers,
    onState: state => states.push(state),
  });
  t.is(sockets.length, 1);
  t.is(sockets[0].binaryType, 'arraybuffer');
  sockets[0].accept();
  const powers = await connection.powers();
  const factory = E(powers.operator).getFactory();
  t.is((await E(factory).listSessions()).rows.length, 1, 'calls pass through');
  t.true(
    sockets[0].sentKinds.every(/** @param {number} kind */ kind => kind === 1),
    'binary frames',
  );
  t.deepEqual(states, ['connecting', 'open']);

  sockets[0].drop();
  t.deepEqual(states.slice(2), ['reconnecting']);
  clock.advance(0);
  t.is(sockets.length, 2, 'first retry at once');
  sockets[1].refuse();
  t.deepEqual(states.slice(3), ['starting'], 'refused: Server starting...');
  clock.advance(999);
  t.is(sockets.length, 2);
  clock.advance(1);
  t.is(sockets.length, 3, 'second retry after 1 s');
  sockets[2].refuse();
  clock.advance(2000);
  t.is(sockets.length, 4, 'third after 2 s');
  // a socket that never opens nor closes: the deadline drops it
  clock.advance(connectDeadlineMs);
  t.is(states.at(-1), 'starting');
  clock.advance(5000);
  t.is(sockets.length, 5, 'fourth after 5 s');
  sockets[4].accept();
  await flush();
  t.is(states.at(-1), 'open');
  sockets[4].drop();
  clock.advance(0);
  t.is(sockets.length, 6, 'a good connection resets the schedule');
  connection.close();
  clock.advance(60_000);
  t.is(sockets.length, 6, 'closed: no more retries');
});

test('a rejected fetch stops retrying and shows its text', async t => {
  const fake = makeFakePowers({});
  const { FakeSocket, sockets, fetched } = makeSockets({
    secret: 'good',
    powers: () => fake.powers,
  });
  const clock = makeClock();
  /** @type {Array<[string, any]>} */
  const states = [];
  const connection = makeConnection({
    url: 'ws://127.0.0.1:1/ws',
    agent: 'stale',
    WebSocket: FakeSocket,
    timers: clock.timers,
    onState: (state, detail) => states.push([state, detail]),
  });
  sockets[0].accept();
  await t.throwsAsync(() => connection.powers(), {
    message: 'Sign-in refused',
  });
  t.deepEqual(fetched, ['stale']);
  t.deepEqual(states.at(-1), ['refused', { message: 'Sign-in refused' }]);
  clock.advance(120_000);
  t.is(sockets.length, 1);
});

test('controller over a connection: a reconnect rebuilds list and view', async t => {
  const fake = makeFakePowers({ sessions: [{ turns: 2 }, {}] });
  const { FakeSocket, sockets } = makeSockets({
    secret: 's',
    powers: () => fake.powers,
  });
  const clock = makeClock();
  const controller = makeController({
    storage: undefined,
    locks: { request: (_name, callback) => callback() },
  });
  makeConnection({
    url: 'ws://127.0.0.1:1/ws',
    agent: 's',
    WebSocket: FakeSocket,
    timers: clock.timers,
    onState: (state, detail) => {
      if (state === 'open') controller.attach(detail?.powers);
      else controller.setConnection(state, detail?.message);
    },
  });
  sockets[0].accept();
  await flush(60);
  t.is(controller.getState().sessions.length, 2);
  await controller.selectSession('s1');
  await flush(60);
  t.is(controller.getState().view?.messages.length, 2);
  sockets[0].drop();
  t.is(controller.getState().connection, 'reconnecting');
  fake.control.addSession({ title: 'while away' });
  clock.advance(0);
  sockets[1].accept();
  await flush(80);
  const state = controller.getState();
  t.is(state.connection, 'open');
  t.is(state.sessions.length, 3);
  t.is(state.activeKey, 's1');
  t.is(state.view?.messages.length, 2);
  t.is(fake.control.callsOf('Session', 'watch').length, 2);
  t.is(fake.control.callsOf('Live', 'subscribeList').length, 2);
});
