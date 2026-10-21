// @ts-check

/**
 * @file debugWorker restart sequencing
 * (designs/daemon-debug-worker-restart.md, Phase 2).
 *
 * A fake supervisor answers the manager's envelopes: `suspend` is
 * acknowledged with `suspended`, and the resume-triggering envelope
 * replays the resumed worker's `<login>` as `debug` traffic.
 */

import test from '@endo/ses-ava/prepare-endo.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import {
  encodeHandleRequest,
  makeDebugWorkerRestarter,
} from '../src/debug-worker-restart.js';

const WORKER = 7;

/**
 * @param {{ suspendReply?: 'suspended' | 'suspend-error' }} [opts]
 */
const makeFakeSupervisor = ({ suspendReply = 'suspended' } = {}) => {
  /** @type {Array<{ handle: number, verb: string, payload?: Uint8Array, nonce?: number }>} */
  const sent = [];
  /** @type {Map<number, import('../src/types.js').DebugSession>} */
  const debugSessions = new Map();
  /** @type {Set<number>} */
  const flagged = new Set();
  let suspended = false;
  let nonce = 1;

  /** @type {ReturnType<typeof makeDebugWorkerRestarter>} */
  let restarter;

  /** @type {(handle: number, verb: string, payload?: Uint8Array, nonce?: number) => void} */
  const sendEnvelope = (handle, verb, payload, n) => {
    sent.push({ handle, verb, payload, nonce: n });
    // Replies arrive on a later turn, as from the bus.
    void Promise.resolve().then(() => {
      if (handle === 0 && verb === 'suspend') {
        suspended = suspendReply === 'suspended';
        restarter.handleSuspendReply(
          {
            handle: WORKER,
            verb: suspendReply,
            payload: encodeUtf8(suspended ? 'cafe' : 'suspend: open handles'),
            nonce: /** @type {number} */ (n),
          },
          decodeUtf8,
        );
      } else if (handle === 0 && verb === 'debug-flag') {
        flagged.add(WORKER);
      } else if (handle === WORKER && suspended) {
        // Resume: a flagged worker pauses at <login>.
        suspended = false;
        if (flagged.delete(WORKER)) {
          const session = debugSessions.get(WORKER);
          session?.feedXml(
            encodeUtf8('<xsbug><login name="worker" value="tag-7"/>'),
          );
        }
      }
    });
  };

  restarter = makeDebugWorkerRestarter({
    sendEnvelope,
    allocNonce: () => {
      const n = nonce;
      nonce += 1;
      return n;
    },
    debugSessions,
  });
  return { restarter, sent, debugSessions };
};

test('encodeHandleRequest emits the CBOR map {"handle": n}', t => {
  const prefix = [0xa1, 0x66, ...encodeUtf8('handle')];
  t.deepEqual([...encodeHandleRequest(7)], [...prefix, 7]);
  t.deepEqual([...encodeHandleRequest(300)], [...prefix, 0x19, 0x01, 0x2c]);
  t.deepEqual(
    [...encodeHandleRequest(0x1234_5678)],
    [...prefix, 0x1a, 0x12, 0x34, 0x56, 0x78],
  );
  t.throws(() => encodeHandleRequest(0), { instanceOf: RangeError });
});

test('debugWorker returns a connected debugger with the worker paused', async t => {
  const { restarter, sent, debugSessions } = makeFakeSupervisor();
  const dbg = await restarter.debugWorker(WORKER);

  t.deepEqual(
    sent.map(({ handle, verb }) => [handle, verb]),
    [
      [0, 'suspend'],
      [0, 'debug-flag'],
      [WORKER, 'ping'],
    ],
    'suspend, then flag, then trigger the resume',
  );
  t.deepEqual(sent[0].payload, encodeHandleRequest(WORKER));
  t.deepEqual(sent[1].payload, encodeHandleRequest(WORKER));
  t.true(debugSessions.has(WORKER), 'session receives debug traffic');
  t.is(dbg.getTitle(), 'worker');
  t.is(dbg.getTag(), 'tag-7');
  t.false(
    sent.some(({ verb }) => verb === 'debug'),
    'no command released the worker',
  );

  dbg.go();
  const last = sent[sent.length - 1];
  t.is(last.handle, WORKER);
  t.is(last.verb, 'debug');
  t.regex(decodeUtf8(/** @type {Uint8Array} */ (last.payload)), /<go\/>/);
});

test('debugWorker rejects and leaves no flag when suspend fails', async t => {
  const { restarter, sent, debugSessions } = makeFakeSupervisor({
    suspendReply: 'suspend-error',
  });
  await t.throwsAsync(() => restarter.debugWorker(WORKER), {
    message: /open handles/,
  });
  t.deepEqual(
    sent.map(({ verb }) => verb),
    ['suspend'],
  );
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
