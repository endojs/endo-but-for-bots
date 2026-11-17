// @ts-check
// M2 W2.6: the scripted provider's additions for turn-completeness tests
// (resources/agent-host/impl/providers/scripted.js): `ScriptRound.times`
// and the system prompt's digest in the `context` log line.
import '../unit/_m1a-prelude.js';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  makeScriptedProvider,
  scriptRoundAt,
  systemDigest,
} from '../../resources/agent-host/impl/providers/scripted.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, matches } = /** @type {GuestGlobals} */ (globalThis);

test('scriptRoundAt: rounds in order, each `times` times', t => {
  const a = { chunks: [{ text: 'a' }] };
  const b = { toolCalls: [{ name: 'echo' }], times: 3 };
  const c = { chunks: [{ text: 'c' }] };
  const turn = { rounds: [a, b, c] };
  t.deepEqual(
    [0, 1, 2, 3, 4, 5].map(n => scriptRoundAt(turn, n)),
    [a, b, b, b, c, undefined],
  );
  t.is(scriptRoundAt(undefined, 0), undefined);
  // The guard admits the round limit plus the closing round, no more.
  const round = { toolCalls: [{ name: 'echo', args: '{}' }] };
  t.true(
    matches(
      harden({
        turns: [{ rounds: [{ ...round, times: limits.maxToolRounds + 1 }] }],
      }),
      shapes.Script,
    ),
  );
  t.false(
    matches(
      harden({
        turns: [{ rounds: [{ ...round, times: limits.maxToolRounds + 2 }] }],
      }),
      shapes.Script,
    ),
  );
});

test('the context line carries the system prompt’s bytes and digest', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'w26-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'scripted.log');
  const timers = makeTimers();
  const provider = makeScriptedProvider({
    label: 'scripted',
    script: harden({ turns: [{ rounds: [{ chunks: [{ text: 'ok' }] }] }] }),
    logPath,
    timers,
  });
  /** @type {any[]} */
  const finals = [];
  const sink = Far('TurnSink', {
    dispatching: () => true,
    roundFinal: (/** @type {any} */ r) => finals.push(r),
    roundFailed: () => {},
  });
  const channel = { publishDelta: () => {} };
  const system = 'You are Floot — brief.';
  for (const req of [
    { system },
    {}, // no system prompt: no fields
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await provider.startRound(
      harden({
        turn: Far('Turn', {}),
        sink,
        turnId: 't1',
        round: 0,
        base: { count: 0, epoch: 0 },
        append: [],
        tools: [],
        options: { modelId: 'scripted' },
        ...req,
      }),
      channel,
      async () => harden({ transcript: [] }),
      undefined,
    );
  }
  await timers.delay(30);
  const lines = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(line => line.kind === 'context');
  t.is(lines.length, 2);
  t.like(lines[0], {
    systemBytes: Buffer.byteLength(system),
    systemDigest: createHash('sha256')
      .update(system)
      .digest('hex')
      .slice(0, 16),
  });
  t.deepEqual(systemDigest(system), {
    systemBytes: lines[0].systemBytes,
    systemDigest: lines[0].systemDigest,
  });
  t.false('systemDigest' in lines[1]);
  t.is(finals.length, 2);
});
