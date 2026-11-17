// @ts-check
/**
 * Crash consistency of the hub's batched commits (core candidate C-20 of the
 * harness journal): a disposable observer's frames delivered in one turn
 * commit once, and a hub flush toward a durable worker is journaled with
 * one fsync. A child process (`_hub-crash-child.mjs`) runs the hub over the
 * real file store and the real worker transport and SIGKILLs itself just
 * before its k-th durable file operation, during a GC burst and during
 * ordinary traffic; a second process recovers from the same directory and
 * finishes. For every kill point:
 *
 * - no frame is delivered twice to the vat: the worker journal's hub
 *   sequences strictly increase, and each released export position appears
 *   in exactly one `op:gc-exports` frame toward the worker;
 * - no frame is lost: every position is released (by the observer's GC
 *   frame or by its retirement at restart), the deliveries the observer
 *   made reach the worker in order without a gap, and every outbox drains;
 * - export counts match: the hub's reference rows end as the uninterrupted
 *   run's do (none left);
 * - replay is byte-identical: the journal the killed process left is a
 *   byte prefix of the recovered journal (nothing journaled is rewritten),
 *   and for sequenced traffic alone the recovered journal is the
 *   uninterrupted run's, byte for byte.
 *
 * Kill points are drawn at random (the seed is in the test title; set
 * HUB_CRASH_SEED to repeat one, HUB_CRASH_ALL=1 to try every point).
 *
 * Both hub stores run every scenario: the whole-file `hub.json` and the log
 * of deltas (C-2), which here migrates the crafted whole-file state at its
 * first open and compacts every few commits, so kills also land inside a
 * migration and inside compactions. The log store's uninterrupted journal
 * must equal the whole-file store's byte for byte: the store changes how
 * the state is written, never what the hub sends.
 */
/* eslint-disable no-await-in-loop */
import test from '@endo/ses-ava/test.js';

import { decodeBase64 } from '@endo/base64';
import { syrupCodec } from '@endo/ocapn/syrup';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('_hub-crash-child.mjs', import.meta.url));
const W = 'f'.repeat(32);
const N = 20;
const SAMPLES = 8;
const seed = Number(
  process.env.HUB_CRASH_SEED ?? Math.floor(Math.random() * 2 ** 31),
);

/**
 * @param {string[]} args
 * @returns {Promise<{ signal: string | null, code: number | null, out: any }>}
 */
const run = args =>
  new Promise(resolve => {
    execFile(
      process.execPath,
      [child, ...args],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const line = stdout
          .split('\n')
          .filter(l => l.startsWith('{'))
          .pop();
        resolve({
          signal: /** @type {any} */ (error)?.signal ?? null,
          code: /** @type {any} */ (error)?.code ?? (error ? 1 : 0),
          out: line ? JSON.parse(line) : undefined,
        });
      },
    );
  });

/** @param {string} root */
const journalPath = root => join(root, 'workers', W, 'journal.jsonl');
/** @param {string} root */
const journalText = root =>
  existsSync(journalPath(root)) ? readFileSync(journalPath(root), 'utf8') : '';

/**
 * The worker journal's entries, decoded: kind, positions released or the
 * ping's number, and the hub sequence.
 * @param {string} text
 */
const entriesOf = text =>
  text
    .split('\n')
    .filter(line => line !== '')
    .slice(1)
    .map(line => {
      const entry = JSON.parse(line);
      const reader = syrupCodec.makeReader(decodeBase64(entry.b64));
      reader.enterRecord();
      const kind = reader.readSelectorAsString();
      /** @type {number[]} */
      const values = [];
      if (kind === 'op:gc-exports') {
        reader.enterList();
        while (!reader.peekListEnd()) values.push(Number(reader.readInteger()));
      } else {
        reader.enterRecord();
        reader.readSelectorAsString();
        reader.readInteger();
        reader.exitRecord();
        reader.enterList();
        reader.readSelectorAsString();
        values.push(Number(reader.readInteger()));
      }
      return { kind, values, hubSequence: BigInt(entry.hubSequence) };
    });

/**
 * A small deterministic generator for the kill points (Park-Miller).
 * @param {number} start
 */
const makeRandom = start => {
  let state = (start % 2_147_483_646) + 1;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

/**
 * @param {number} total
 * @param {() => number} random
 */
const killPoints = (total, random) => {
  if (process.env.HUB_CRASH_ALL)
    return Array.from({ length: total }, (_, i) => i + 1);
  const points = new Set([1, total]);
  while (points.size < Math.min(SAMPLES, total))
    points.add(1 + Math.floor(random() * total));
  return [...points].sort((a, b) => a - b);
};

for (const [hubStore, scenario] of /** @type {const} */ ([
  ['file', 'burst'],
  ['file', 'ordinary'],
  ['log', 'burst'],
  ['log', 'ordinary'],
])) {
  test(`SIGKILL at random commit points during ${scenario === 'burst' ? 'a GC burst' : 'ordinary traffic'} loses and repeats nothing, ${hubStore} hub store (seed ${seed})`, async t => {
    t.timeout(600_000);
    const root = await mkdtemp(join(tmpdir(), 'thix-hub-crash-'));
    t.teardown(() => rm(root, { recursive: true, force: true }));
    const storeArgs = [hubStore];
    const reference = join(root, 'reference');
    const done = await run([
      reference,
      'fresh',
      scenario,
      String(N),
      '0',
      ...storeArgs,
    ]);
    t.is(done.code, 0);
    t.deepEqual(done.out.refs, [], 'the uninterrupted run releases every row');
    const referenceJournal = journalText(reference);
    const total = done.out.durableOps;
    t.log(
      `${scenario}, ${hubStore} store: ${total} durable operations uninterrupted; store ${JSON.stringify(done.out.hubStore)}`,
    );
    if (hubStore === 'log') {
      t.true(done.out.hubStore.migrated === 1, 'the run migrated hub.json');
      t.true(Number(done.out.hubStore.compactions) > 2, 'the run compacted');
      const wholeFile = join(root, 'whole-file');
      const control = await run([
        wholeFile,
        'fresh',
        scenario,
        String(N),
        '0',
        'file',
      ]);
      t.is(control.code, 0);
      t.is(
        referenceJournal,
        journalText(wholeFile),
        'the log store sends what the whole-file store sends, byte for byte',
      );
    }
    const random = makeRandom(
      seed + (scenario === 'burst' ? 0 : 1) + (hubStore === 'log' ? 2 : 0),
    );
    for (const k of killPoints(total, random)) {
      const dir = join(root, `k${k}`);
      const killed = await run([
        dir,
        'fresh',
        scenario,
        String(N),
        String(k),
        ...storeArgs,
      ]);
      t.is(killed.signal, 'SIGKILL', `killed before durable operation ${k}`);
      const before = journalText(dir);
      const recovered = await run([
        dir,
        'recover',
        scenario,
        String(N),
        '0',
        ...storeArgs,
      ]);
      t.is(recovered.code, 0, `recovered after kill point ${k}`);
      t.deepEqual(recovered.out?.refs, [], `k=${k}: export counts match`);
      t.true(
        Object.values(recovered.out?.queues ?? { x: 1 }).every(n => n === 0),
        `k=${k}: every outbox drained`,
      );
      const after = journalText(dir);
      t.true(
        after.startsWith(before),
        `k=${k}: the journal the kill left is a prefix of the recovered one`,
      );
      const entries = entriesOf(after);
      t.true(
        entries.every(
          (e, i) => i === 0 || e.hubSequence > entries[i - 1].hubSequence,
        ),
        `k=${k}: hub sequences strictly increase (nothing journaled twice)`,
      );
      const released = entries
        .filter(e => e.kind === 'op:gc-exports')
        .flatMap(e => e.values)
        .sort((a, b) => a - b);
      t.deepEqual(
        released,
        Array.from({ length: N }, (_, i) => i + 1),
        `k=${k}: each export released exactly once`,
      );
      const pings = entries
        .filter(e => e.kind === 'op:deliver')
        .flatMap(e => e.values);
      if (scenario === 'ordinary') {
        t.is(
          after,
          referenceJournal,
          `k=${k}: byte-identical to uninterrupted`,
        );
      } else {
        const fromObserver = pings.filter(n => n < 1000);
        t.deepEqual(
          fromObserver,
          fromObserver.map((_, i) => i + 1),
          `k=${k}: the observer's deliveries arrive in order without a gap`,
        );
        t.deepEqual(
          pings.filter(n => n >= 1000),
          [],
          'the sequenced session sends no deliveries in this scenario',
        );
      }
    }
  });
}
