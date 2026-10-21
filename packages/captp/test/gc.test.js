// @ts-check

import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { Far } from '@endo/marshal';
import { E, makeLoopback } from '../src/loopback.js';

import { detectEngineGC } from './engine-gc.js';
import { makeGcAndFinalize } from './gc-and-finalize.js';

const isolated = async (t, makeFar) => {
  await null;
  const local = Far('local', {
    method: () => 'local',
  });
  const far = makeFar(local);
  t.is(await E(far).method(), 'local');
};

test.serial('test loopback gc', async t => {
  t.timeout(10_000);
  const { makeFar, getFarStats, getNearStats } = makeLoopback(
    'dean',
    { gcImports: true },
    { gcImports: true },
  );
  const gcAndFinalize = await makeGcAndFinalize(detectEngineGC());

  await isolated(t, makeFar);
  // Collection can release questions before their answers and imported
  // capabilities. Wait for the complete drop exchange, with a finite bound.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await gcAndFinalize();
    const near = getNearStats();
    const far = getFarStats();
    if (
      Number(near.send.CTP_DROP) >= 3 &&
      Number(near.recv.CTP_DROP) >= 2 &&
      Number(far.send.CTP_DROP) >= 2 &&
      Number(far.recv.CTP_DROP) >= 3 &&
      near.send.CTP_DROP === far.recv.CTP_DROP &&
      near.recv.CTP_DROP === far.send.CTP_DROP &&
      near.gc.DROPPED === near.recv.CTP_DROP &&
      far.gc.DROPPED === far.recv.CTP_DROP
    )
      break;
  }

  // Check the GC stats.
  const nearStats = getNearStats();
  const farStats = getFarStats();
  const nearSendDrop = Number(nearStats.send.CTP_DROP);
  const nearRecvDrop = Number(nearStats.recv.CTP_DROP);
  const nearDropped = Number(nearStats.gc.DROPPED);
  const farSendDrop = Number(farStats.send.CTP_DROP);
  const farRecvDrop = Number(farStats.recv.CTP_DROP);
  const farDropped = Number(farStats.gc.DROPPED);
  // The exact number of drops can vary by one depending on finalization timing.
  // Assert pairwise consistency and lower bounds instead of exact totals.
  t.true(nearSendDrop >= 3);
  t.true(nearRecvDrop >= 2);
  t.true(nearDropped >= 2);
  t.true(farSendDrop >= 2);
  t.true(farRecvDrop >= 3);
  t.true(farDropped >= 3);
  t.is(nearSendDrop, farRecvDrop);
  t.is(nearRecvDrop, farSendDrop);
  t.is(nearDropped, nearRecvDrop);
  t.is(farDropped, farRecvDrop);
});

test.serial(
  'collected questions release their streamed copy-record answers',
  async t => {
    t.timeout(10_000);
    /** @type {WeakRef<object>[]} */
    const records = [];
    const local = Far('stream', {
      read() {
        const record = harden({ payload: 'x'.repeat(8192) });
        records.push(new WeakRef(record));
        return record;
      },
    });
    const { makeFar, getFarStats } = makeLoopback(
      'stream-gc',
      { gcImports: true },
      { gcImports: true },
    );
    const gcAndFinalize = await makeGcAndFinalize(detectEngineGC());
    const consume = async () => {
      const remote = await makeFar(local);
      for (let i = 0; i < 64; i += 1) {
        // Discard each received record and its question promise.
        // eslint-disable-next-line no-await-in-loop
        await E(remote).read();
      }
    };
    await consume();
    // Question collection sends CTP_DROP; receiving that releases an answer
    // promise, whose collection then releases its payload. These dependent
    // finalization stages need not finish in exactly two engine collections.
    let retained = records.length;
    for (let attempt = 0; attempt < 8 && retained > 0; attempt += 1) {
      // The helper crosses turn boundaries before collecting, so deref() in
      // the previous check cannot keep a payload alive for the next sweep.
      // eslint-disable-next-line no-await-in-loop
      await gcAndFinalize();
      retained = records.filter(ref => ref.deref() !== undefined).length;
    }
    t.is(records.length, 64);
    t.true(Number(getFarStats().gc.DROPPED) >= 64);
    t.is(retained, 0, 'all dropped answers release their copy-record payloads');
  },
);
