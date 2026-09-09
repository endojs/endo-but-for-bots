// @ts-check
import { makeError } from '@endo/errors';
import harden from '@endo/harden';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { makeThixotropeDaemon } from '../src/daemon.js';
import { makePeerJournalReplayEngine } from '../src/peer-replay-engine.js';
import { makeFsStore } from '../src/store-fs.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import { ExecutionContext } from 'ava' */

const token = 'abcdef0123456789abcdef0123456789';

/**
 * Exercise production resumption against real session files. The fault is an
 * explicit refusal before a metadata write, not actual disk exhaustion or an
 * emulation of a partially completed filesystem transaction.
 * @param {ExecutionContext} t
 * @param {string} [existingPath]
 */
const setup = async (t, existingPath = undefined) => {
  const path = existingPath ?? (await mkdtemp(join(tmpdir(), 'thix-storage-')));
  if (existingPath === undefined) {
    t.teardown(() => rm(path, { recursive: true, force: true }));
  }
  const store = makeFsStore(nodePowers, path);
  let refuse = false;
  /** @type {any} */
  let power;
  const daemon = await makeThixotropeDaemon(nodePowers, {
    store: harden({
      ...store,
      provideSessionStore: sessionToken => {
        const session = store.provideSessionStore(sessionToken);
        return harden({
          ...session,
          setMeta: meta => {
            if (refuse) throw makeError('ENOSPC: injected metadata refusal');
            session.setMeta(meta);
          },
        });
      },
    }),
    engine: makePeerJournalReplayEngine(nodePowers),
    codec: syrupCodec,
    makeNetlayer: ({ resumption }) => {
      power = resumption;
      return {
        location: {
          type: 'ocapn-peer',
          transport: 'test',
          designator: 'storage-test',
          hints: false,
        },
        shutdown() {},
      };
    },
  });
  t.teardown(() => daemon.shutdown());
  return {
    path,
    power,
    daemon,
    refuseWrites: () => {
      refuse = true;
    },
    disk: () =>
      makeFsStore(nodePowers, path).provideSessionStore(token).getMeta(),
  };
};

for (const boundary of [
  'outbox acceptance',
  'inbox acceptance',
  'acknowledgement reclamation',
  'processed inbox cleanup',
]) {
  test.serial(
    `storage refusal preserves obligations at ${boundary}`,
    async t => {
      t.timeout(30_000);
      const first = await setup(t);
      first.power.onHello(token);
      const sent = new Uint8Array([11, 22, 33]);
      const received = new Uint8Array([44, 55, 66]);
      // Existing obligations must survive a failed update, not merely an empty
      // initial session. Keep both directions populated throughout the fault.
      first.power.recordOutbound(token, 1n, sent, '17');
      first.power.recordInbound(token, 1n, received);
      const before = first.disk();
      const attempt = (/** @type {any} */ power) => {
        if (boundary === 'outbox acceptance') {
          power.recordOutbound(token, 2n, received, '18');
        } else if (boundary === 'inbox acceptance') {
          power.recordInbound(token, 2n, sent);
        } else if (boundary === 'acknowledgement reclamation') {
          power.recordAck(token, 1n);
        } else {
          power.recordProcessed(token, 1n);
        }
      };
      first.refuseWrites();
      t.throws(() => attempt(first.power), { message: /ENOSPC/ });
      t.deepEqual(
        first.disk(),
        before,
        'failed write preserves the durable cut',
      );
      await first.daemon.shutdown();
      const second = await setup(t, first.path);
      const recovered = second.power.loadForResume(token);
      t.deepEqual(recovered.frames, [{ n: '1', bytes: sent }]);
      t.deepEqual(recovered.inbox, [{ n: '1', bytes: received }]);
      t.is(recovered.hubDelivery, '17');
      t.is(recovered.ackSeq, '0');
      t.is(recovered.recvSeq, '1');
      attempt(second.power);
      const after = second.power.loadForResume(token);
      t.is(after.sendSeq, boundary === 'outbox acceptance' ? '2' : '1');
      t.is(after.recvSeq, boundary === 'inbox acceptance' ? '2' : '1');
      t.is(
        after.ackSeq,
        boundary === 'acknowledgement reclamation' ? '1' : '0',
      );
      t.deepEqual(
        after.frames,
        boundary === 'acknowledgement reclamation'
          ? []
          : boundary === 'outbox acceptance'
            ? [
                { n: '1', bytes: sent },
                { n: '2', bytes: received },
              ]
            : [{ n: '1', bytes: sent }],
      );
      t.deepEqual(
        after.inbox,
        boundary === 'processed inbox cleanup'
          ? []
          : boundary === 'inbox acceptance'
            ? [
                { n: '1', bytes: received },
                { n: '2', bytes: sent },
              ]
            : [{ n: '1', bytes: received }],
      );
      // Drain all obligations after recovery and prove the session remains usable.
      second.power.recordAck(token, BigInt(after.sendSeq));
      second.power.recordProcessed(token, 1n);
      if (boundary === 'inbox acceptance')
        second.power.recordProcessed(token, 2n);
      second.power.recordOutbound(token, BigInt(after.sendSeq) + 1n, sent);
      t.deepEqual(second.power.loadForResume(token).inbox, []);
      t.deepEqual(second.power.loadForResume(token).frames, [
        { n: String(BigInt(after.sendSeq) + 1n), bytes: sent },
      ]);
    },
  );
}

test.serial(
  'filesystem backlog survives repeated recovery and drains in order',
  async t => {
    t.timeout(60_000);
    let current = await setup(t);
    current.power.onHello(token);
    // Array-backed fixture size is deliberately bounded; protocol identities are
    // bigint. This is a backlog regression, not a throughput benchmark.
    const count = 128;
    const payloads = Array.from({ length: count }, (_, index) => {
      const bytes = new Uint8Array(1024);
      bytes.fill(index);
      return bytes;
    });
    for (const [index, bytes] of payloads.entries()) {
      current.power.recordOutbound(token, BigInt(index) + 1n, bytes);
      current.power.recordInbound(token, BigInt(index) + 1n, bytes);
    }
    for (let start = 0; start < count; start += 32) {
      const path = current.path;
      // Each recovery depends on the previous batch having committed.
      // eslint-disable-next-line no-await-in-loop
      await current.daemon.shutdown();
      // eslint-disable-next-line no-await-in-loop
      current = await setup(t, path);
      const expected = payloads.slice(start).map((bytes, offset) => ({
        n: String(BigInt(start + offset) + 1n),
        bytes,
      }));
      const resumed = current.power.loadForResume(token);
      t.deepEqual(resumed.frames, expected);
      t.deepEqual(resumed.inbox, expected);
      for (let index = start; index < start + 32; index += 1) {
        const n = BigInt(index) + 1n;
        // Duplicate acceptance and duplicate confirmation cannot grow the backlog
        // or discard the next message, including after each restart.
        current.power.recordInbound(token, n, payloads[index]);
        current.power.recordProcessed(token, n);
        current.power.recordProcessed(token, n);
        current.power.recordAck(token, n);
        current.power.recordAck(token, n);
      }
    }
    await current.daemon.shutdown();
    const final = await setup(t, current.path);
    const resumed = final.power.loadForResume(token);
    t.deepEqual(resumed.frames, []);
    t.deepEqual(resumed.inbox, []);
    t.is(resumed.sendSeq, String(count));
    t.is(resumed.recvSeq, String(count));
    t.is(resumed.ackSeq, String(count));
    t.is(final.disk().processedSeq, String(count));
  },
);

const execFileAsync = promisify(execFile);
/**
 * @param {ExecutionContext} t
 * @param {string[]} args
 */
const runChild = (t, args) => {
  const result = execFileAsync(process.execPath, args, { timeout: 10_000 });
  t.teardown(() => {
    result.child.kill();
  });
  return result;
};
const syscallChild = fileURLToPath(
  new URL('./_session-store-syscall-fault.mjs', import.meta.url),
);

for (const phase of [
  'partial-write',
  'temp-fsync',
  'rename',
  'directory-fsync',
]) {
  test.serial(
    `session metadata publication survives ${phase} failure`,
    async t => {
      t.timeout(30_000);
      const path = await mkdtemp(join(tmpdir(), 'thix-syscall-'));
      t.teardown(() => rm(path, { recursive: true, force: true }));
      const session = makeFsStore(nodePowers, path).provideSessionStore(token);
      const before = {
        version: 2,
        recvSeq: '1',
        processedSeq: '0',
        sendSeq: '1',
        ackSeq: '0',
        hubDelivery: '7',
        frames: [{ n: '1', b64: 'AQID' }],
        inbox: [{ n: '1', b64: 'BAUG' }],
      };
      const after = {
        ...before,
        recvSeq: '2',
        inbox: [...before.inbox, { n: '2', b64: 'BwgJ' }],
      };
      session.setMeta(before);
      const fault = await runChild(t, [
        syscallChild,
        path,
        token,
        phase,
        JSON.stringify(after),
      ]);
      const result = JSON.parse(fault.stdout);
      t.is(result.injections, 1, 'the intended syscall was reached');
      t.is(result.errorCode, 'ENOSPC');
      // A failed directory fsync follows rename: the caller has an unknown
      // outcome, but a process restart must see the coherent published image.
      // This does not assert survival of an actual hardware power loss.
      const expected = phase === 'directory-fsync' ? after : before;
      t.deepEqual(result.meta, expected);
      const restart = await runChild(t, [syscallChild, path, token, 'read']);
      t.deepEqual(JSON.parse(restart.stdout).meta, expected);
      // Retry after freeing storage overwrites any abandoned temp file and
      // preserves the prior outbox and accepted inbox contents exactly.
      session.setMeta(after);
      t.deepEqual(
        makeFsStore(nodePowers, path).provideSessionStore(token).getMeta(),
        after,
      );
    },
  );
}
