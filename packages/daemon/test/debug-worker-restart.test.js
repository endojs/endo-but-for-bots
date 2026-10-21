// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import {
  encodeHandleRequest,
  makeDebugWorkerRestarter,
} from '../src/debug-worker-restart.js';
import { makeDebugSession } from '../src/debug-session.js';

/** @import { DebugSession } from '../src/types.js' */

const WORKER = 7;
const OTHER_WORKER = 8;

/**
 * A fake supervisor answering the manager's envelopes on a later turn,
 * as from the bus.  `debug-flag` is acknowledged only for a shared
 * worker; the resume-triggering envelope replays a flagged worker's
 * `<login>` as `debug` traffic.
 *
 * @param {object} [options]
 * @param {'suspended' | 'suspend-error'} [options.suspendReply]
 * @param {'shared' | 'separate' | 'node'} [options.platform]
 */
const makeFakeSupervisor = ({
  suspendReply = 'suspended',
  platform = 'shared',
} = {}) => {
  /** @type {Array<{ handle: number, verb: string, payload?: Uint8Array, nonce?: number }>} */
  const sent = [];
  /** @type {Map<number, DebugSession>} */
  const debugSessions = new Map();
  /** @type {Set<number>} */
  const flagged = new Set();
  let suspended = false;
  let nextNonce = 1;

  /** @type {ReturnType<typeof makeDebugWorkerRestarter>} */
  let restarter;

  /**
   * @param {number} handle
   * @param {string} verb
   * @param {string} text
   * @param {number} nonce
   */
  const reply = (handle, verb, text, nonce) =>
    restarter.handleReply(
      { handle, verb, payload: encodeUtf8(text), nonce },
      decodeUtf8,
    );

  /** @type {(handle: number, verb: string, payload?: Uint8Array, nonce?: number) => void} */
  const sendEnvelope = (handle, verb, payload, nonce) => {
    sent.push({ handle, verb, payload, nonce });
    void Promise.resolve().then(() => {
      const requestNonce = /** @type {number} */ (nonce);
      if (handle === 0 && verb === 'debug-flag') {
        if (platform === 'shared') {
          flagged.add(WORKER);
          reply(0, 'debug-flagged', '', requestNonce);
        } else {
          reply(
            0,
            'error',
            `debug-flag: worker ${WORKER} runs on the ${platform} platform`,
            requestNonce,
          );
        }
      } else if (handle === 0 && verb === 'debug-unflag') {
        flagged.delete(WORKER);
      } else if (handle === 0 && verb === 'suspend') {
        suspended = suspendReply === 'suspended';
        reply(
          WORKER,
          suspendReply,
          suspended ? 'cafe' : 'suspend: open handles',
          requestNonce,
        );
      } else if (handle === WORKER && suspended) {
        // Resume: a flagged worker pauses at <login>.
        suspended = false;
        if (flagged.delete(WORKER)) {
          debugSessions
            .get(WORKER)
            ?.feedXml(
              encodeUtf8('<xsbug><login name="worker" value="tag-7"/>'),
            );
        }
      }
    });
  };

  restarter = makeDebugWorkerRestarter({
    sendEnvelope,
    allocNonce: () => {
      const nonce = nextNonce;
      nextNonce += 1;
      return nonce;
    },
    debugSessions,
  });
  return { restarter, sent, debugSessions, flagged };
};

test('encodeHandleRequest emits the canonical CBOR map {"handle": n}', t => {
  const prefix = [0xa1, 0x66, ...encodeUtf8('handle')];
  /** @type {Array<[number, number[]]>} */
  const vectors = [
    [1, [1]],
    [23, [23]],
    [24, [0x18, 24]],
    [255, [0x18, 0xff]],
    [256, [0x19, 0x01, 0x00]],
    [65_535, [0x19, 0xff, 0xff]],
    [65_536, [0x1a, 0x00, 0x01, 0x00, 0x00]],
    [0x1234_5678, [0x1a, 0x12, 0x34, 0x56, 0x78]],
    [0xffff_ffff, [0x1a, 0xff, 0xff, 0xff, 0xff]],
    [0x1_0000_0000, [0x1b, 0, 0, 0, 0x01, 0, 0, 0, 0]],
    [
      Number.MAX_SAFE_INTEGER,
      [0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    ],
  ];
  for (const [handle, head] of vectors) {
    t.deepEqual(
      [...encodeHandleRequest(handle)],
      [...prefix, ...head],
      `${handle}`,
    );
  }
  for (const handle of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    t.throws(() => encodeHandleRequest(handle), { instanceOf: RangeError });
  }
});

test('debugWorker returns a connected debugger with the worker paused', async t => {
  const { restarter, sent, debugSessions } = makeFakeSupervisor();
  const workerDebugger = await restarter.debugWorker(WORKER);

  t.deepEqual(
    sent.map(({ handle, verb }) => [handle, verb]),
    [
      [0, 'debug-flag'],
      [0, 'suspend'],
      [WORKER, 'ping'],
    ],
    'flag, then suspend, then trigger the resume',
  );
  t.deepEqual(sent[0].payload, encodeHandleRequest(WORKER));
  t.deepEqual(sent[1].payload, encodeHandleRequest(WORKER));
  t.true(debugSessions.has(WORKER), 'session receives debug traffic');
  t.is(workerDebugger.getTitle(), 'worker');
  t.is(workerDebugger.getTag(), 'tag-7');
  t.false(
    sent.some(({ verb }) => verb === 'debug'),
    'no command released the worker',
  );

  workerDebugger.go();
  const last = sent[sent.length - 1];
  t.is(last.handle, WORKER);
  t.is(last.verb, 'debug');
  t.regex(decodeUtf8(/** @type {Uint8Array} */ (last.payload)), /<go\/>/);
});

for (const platform of /** @type {const} */ (['separate', 'node'])) {
  test(`debugWorker rejects a ${platform} worker before suspending it`, async t => {
    const { restarter, sent, debugSessions } = makeFakeSupervisor({
      platform,
    });
    await t.throwsAsync(() => restarter.debugWorker(WORKER), {
      message: new RegExp(`${platform} platform`),
    });
    t.deepEqual(
      sent.map(({ verb }) => verb),
      ['debug-flag'],
    );
    t.false(debugSessions.has(WORKER));
  });
}

test('debugWorker rejects and withdraws the flag when suspend fails', async t => {
  const { restarter, sent, debugSessions, flagged } = makeFakeSupervisor({
    suspendReply: 'suspend-error',
  });
  await t.throwsAsync(() => restarter.debugWorker(WORKER), {
    message: /open handles/,
  });
  t.deepEqual(
    sent.map(({ verb }) => verb),
    ['debug-flag', 'suspend', 'debug-unflag'],
  );
  await null;
  t.false(flagged.has(WORKER));
  t.false(debugSessions.has(WORKER));
});

test('debugWorker refuses a worker that already has a debugger', async t => {
  const { restarter, debugSessions } = makeFakeSupervisor();
  await restarter.debugWorker(WORKER);
  t.true(debugSessions.has(WORKER));
  await t.throwsAsync(() => restarter.debugWorker(WORKER), {
    message: /already has a debugger/,
  });
});

test('concurrent debugWorker calls on one worker restart it once', async t => {
  const { restarter, sent } = makeFakeSupervisor();
  const first = restarter.debugWorker(WORKER);
  const second = restarter.debugWorker(WORKER);
  await t.throwsAsync(second, { message: /already restarting/ });
  const workerDebugger = await first;
  t.is(workerDebugger.getTitle(), 'worker');
  t.is(sent.filter(({ verb }) => verb === 'suspend').length, 1);
});

test('handleReply answers only the expected source, nonce, and verb', async t => {
  /** @type {Array<{ handle: number, verb: string, nonce?: number }>} */
  const sent = [];
  let nextNonce = 5;
  const restarter = makeDebugWorkerRestarter({
    sendEnvelope: (handle, verb, _payload, nonce) => {
      sent.push({ handle, verb, nonce });
    },
    allocNonce: () => {
      const nonce = nextNonce;
      nextNonce += 1;
      return nonce;
    },
    debugSessions: new Map(),
  });
  /**
   * @param {number} handle
   * @param {string} verb
   * @param {number} nonce
   */
  const reply = (handle, verb, nonce) =>
    restarter.handleReply(
      { handle, verb, payload: encodeUtf8(verb), nonce },
      decodeUtf8,
    );

  t.false(reply(WORKER, 'suspended', 9), 'unknown nonce');

  const attempt = restarter.debugWorker(WORKER);
  t.deepEqual(sent, [{ handle: 0, verb: 'debug-flag', nonce: 5 }]);
  t.false(reply(WORKER, 'debug-flagged', 5), 'a worker cannot ack the flag');
  t.true(reply(0, 'debug-flagged', 5));
  await null;
  await null;
  t.deepEqual(sent[1], { handle: 0, verb: 'suspend', nonce: 6 });

  t.false(
    reply(OTHER_WORKER, 'suspended', 6),
    'another worker cannot answer the suspend',
  );
  t.false(reply(WORKER, 'pong', 6), 'unrelated verb leaves it pending');
  t.true(reply(0, 'error', 6));
  await t.throwsAsync(attempt, { message: /"error"/ });
});

test('waitForLogin resolves at once after a <login> without attributes', async t => {
  const session = makeDebugSession(() => {});
  const first = session.waitForLogin();
  session.feedXml(encodeUtf8('<xsbug><login/>'));
  const login = await first;
  t.deepEqual(login, { name: undefined, tag: undefined });
  t.deepEqual(await session.waitForLogin(), {
    name: undefined,
    tag: undefined,
  });
});
