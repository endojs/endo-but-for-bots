// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { makeDebugAttacher } from '../src/debug-attach.js';

/** @import { DebugSession } from '../src/types.js' */

const WORKER = 7;
const OTHER_WORKER = 8;

/**
 * A fake bus that records the manager's envelopes and lets each test
 * play the worker's replies.
 */
const makeFakeBus = () => {
  /** @type {Array<{ handle: number, verb: string, payload?: Uint8Array, nonce?: number }>} */
  const sent = [];
  /** @type {Map<number, DebugSession>} */
  const debugSessions = new Map();
  let nextNonce = 1;
  const attacher = makeDebugAttacher({
    sendEnvelope: (handle, verb, payload, nonce) => {
      sent.push({ handle, verb, payload, nonce });
    },
    allocNonce: () => {
      const nonce = nextNonce;
      nextNonce += 1;
      return nonce;
    },
    debugSessions,
  });

  /**
   * Acknowledge the most recent `debug-attach`, as from `handle`.
   *
   * @param {number} [handle]
   */
  const acknowledge = (handle = WORKER) => {
    const request = sent.findLast(({ verb }) => verb === 'debug-attach');
    if (request === undefined) {
      throw Error('no debug-attach was sent');
    }
    return attacher.handleAttached({
      handle,
      verb: 'debug-attached',
      payload: new Uint8Array(),
      nonce: /** @type {number} */ (request.nonce),
    });
  };

  return { sent, debugSessions, attacher, acknowledge };
};

test('attach sends debug-attach and resolves to a Debugger once acknowledged', async t => {
  const { sent, debugSessions, attacher, acknowledge } = makeFakeBus();

  const attached = attacher.attach(WORKER);
  t.deepEqual(
    sent.map(({ handle, verb }) => [handle, verb]),
    [[WORKER, 'debug-attach']],
  );
  t.false(debugSessions.has(WORKER), 'no session before the acknowledgement');

  t.true(acknowledge());
  const debuggerRef = await attached;
  t.true(debugSessions.has(WORKER));
  t.is(typeof debuggerRef.step, 'function');
  t.false(debuggerRef.isBroken());
});

test('the Debugger drives the worker over its debug session', async t => {
  const { sent, debugSessions, attacher, acknowledge } = makeFakeBus();

  const attached = attacher.attach(WORKER);
  acknowledge();
  const debuggerRef = await attached;

  debuggerRef.setBreakpoint('main.js', 3);
  const command = sent.at(-1);
  t.is(command?.handle, WORKER);
  t.is(command?.verb, 'debug');
  t.regex(
    decodeUtf8(/** @type {Uint8Array} */ (command?.payload)),
    /set-breakpoint/,
  );

  const session = /** @type {DebugSession} */ (debugSessions.get(WORKER));
  session.feedXml(
    encodeUtf8(
      '<xsbug><login name="worker" value="7"/></xsbug>' +
        '<xsbug><break path="main.js" line="3">breakpoint</break></xsbug>',
    ),
  );
  t.true(debuggerRef.isBroken());
  t.like(debuggerRef.getLastBreak(), { path: 'main.js', line: 3 });
});

test('concurrent attaches to one worker share one request', async t => {
  const { sent, attacher, acknowledge } = makeFakeBus();

  const first = attacher.attach(WORKER);
  const second = attacher.attach(WORKER);
  t.is(first, second);
  t.is(sent.filter(({ verb }) => verb === 'debug-attach').length, 1);

  acknowledge();
  await first;
});

test('attaching to a worker that has a session reuses it', async t => {
  const { sent, attacher, acknowledge } = makeFakeBus();

  const first = attacher.attach(WORKER);
  acknowledge();
  await first;

  await attacher.attach(WORKER);
  t.is(
    sent.filter(({ verb }) => verb === 'debug-attach').length,
    1,
    'no second debug-attach',
  );
});

test('an acknowledgement from another worker is not an answer', async t => {
  const { debugSessions, attacher, acknowledge } = makeFakeBus();

  const attached = attacher.attach(WORKER);
  t.false(acknowledge(OTHER_WORKER));
  t.false(debugSessions.has(WORKER));
  t.false(debugSessions.has(OTHER_WORKER));

  t.true(acknowledge(WORKER));
  await attached;
});

test('an unsolicited acknowledgement is not an answer', t => {
  const { attacher } = makeFakeBus();
  t.false(
    attacher.handleAttached({
      handle: WORKER,
      verb: 'debug-attached',
      payload: new Uint8Array(),
      nonce: 99,
    }),
  );
});

test('detach sends debug-detach and drops the session', async t => {
  const { sent, debugSessions, attacher, acknowledge } = makeFakeBus();

  const attached = attacher.attach(WORKER);
  acknowledge();
  await attached;

  attacher.detach(WORKER);
  t.false(debugSessions.has(WORKER));
  t.deepEqual(
    sent.slice(-1).map(({ handle, verb }) => [handle, verb]),
    [[WORKER, 'debug-detach']],
  );

  // A later attach asks the worker again.
  const again = attacher.attach(WORKER);
  t.is(sent.at(-1)?.verb, 'debug-attach');
  acknowledge();
  await again;
});

test('detaching a worker with no debugger sends nothing', t => {
  const { sent, attacher } = makeFakeBus();
  attacher.detach(WORKER);
  t.deepEqual(sent, []);
});

test('a worker that closes rejects its pending attach', async t => {
  const { attacher } = makeFakeBus();

  const attached = attacher.attach(WORKER);
  attacher.forgetWorker(WORKER);
  await t.throwsAsync(attached, {
    message: /closed before the debugger attached/,
  });

  // The late acknowledgement answers nothing.
  t.false(
    attacher.handleAttached({
      handle: WORKER,
      verb: 'debug-attached',
      payload: new Uint8Array(),
      nonce: 1,
    }),
  );
});

test('a worker that closes loses its session', async t => {
  const { debugSessions, attacher, acknowledge } = makeFakeBus();

  const attached = attacher.attach(WORKER);
  acknowledge();
  await attached;

  attacher.forgetWorker(WORKER);
  t.false(debugSessions.has(WORKER));
});
