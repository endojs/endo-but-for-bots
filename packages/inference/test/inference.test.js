import test from '@endo/ses-ava/prepare-endo.js';
import { mustMatch } from '@endo/patterns';

import { makeSlotAdmission, withAdmission, withUsageRecord } from '../index.js';
import { InferResultShape, UsageRecordShape } from '../src/interface.js';

const makeGatedBackend = () => {
  const gates = [];
  return {
    gates,
    backend: harden({
      describe: () => ({ kind: 'fake', provider: 'none' }),
      infer: () =>
        new Promise(resolve => {
          gates.push(() => resolve(harden({ type: 'ok', text: 'done' })));
        }),
    }),
  };
};

test('admission is per credential', async t => {
  const admission = makeSlotAdmission();
  const a = makeGatedBackend();
  const b = makeGatedBackend();
  const limits = { wallClockMs: 1, outputBytes: 1, maxTurns: 1 };
  const onA = withAdmission(a.backend, { admission, credentialId: 'A' });
  const onB = withAdmission(b.backend, { admission, credentialId: 'B' });
  const first = onA.infer({ prompt: 'x', guest: null, limits });
  t.deepEqual(await onA.infer({ prompt: 'x', guest: null, limits }), {
    type: 'rate-limited',
  });
  const other = onB.infer({ prompt: 'x', guest: null, limits });
  await null;
  t.is(b.gates.length, 1, 'a busy credential A does not block credential B');
  a.gates[0]();
  b.gates[0]();
  t.is((await first).type, 'ok');
  t.is((await other).type, 'ok');
  t.is(admission.inUse('A'), 0);
});

test('usage record matches the shape and omits credential bytes', async t => {
  const records = [];
  const backend = withUsageRecord(
    harden({
      describe: () => ({ kind: 'fake', provider: 'none', version: '1' }),
      infer: async () => harden({ type: 'unavailable', reason: 'nope' }),
    }),
    { credentialId: 'secret-id-1', sink: r => records.push(r) },
  );
  const result = await backend.infer({
    prompt: 'x',
    guest: null,
    limits: { wallClockMs: 1, outputBytes: 1, maxTurns: 1 },
  });
  mustMatch(result, InferResultShape);
  t.is(records.length, 1);
  mustMatch(records[0], UsageRecordShape);
  t.is(records[0].detail, 'nope');
});
