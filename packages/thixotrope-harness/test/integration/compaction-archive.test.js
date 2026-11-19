// @ts-check
/**
 * Compaction of a long, archived session and of an exported one
 * (`designs/m8-interfaces.md` 12, acceptance 9 and 10; D-M8-3, D-M8-16),
 * from the m1a state template on a scripted backend. The long session is
 * built by import (`writeSyntheticExport`, `importState`; process.md 3),
 * never by replaying turns.
 *
 * 9. A session of 300 imported turns (sealed segments) compacts at a
 *    scripted reading of 80 of 100: the boundary lies in the kept records
 *    (at or past `sealedTo`), the archive's `manifest.json` and the head of
 *    `context.jsonl` take the new epoch and boundary, the supervisor is
 *    killed and served again, and the context the backend receives after
 *    the restart equals the one before (the same per-turn digests of the
 *    scripted `context` line); history still shows every turn from turn 1.
 * 10. "export": a compacted session exported and imported into a fresh
 *    state sends the same context (summary first, the same tail) as the
 *    source for the same next turn.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/compaction-archive.test.js
 */
import '../unit/_m1a-prelude.js';

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

import { scriptedSummary } from '../../resources/agent-host/impl/providers/compaction-texts.js';
import { exportState, importState } from '../../scripts/export.mjs';
import {
  integrationEnabled,
  shortName,
  startFromTemplate,
  takeIntegrationLock,
  tmpRoot,
} from '../template/index.js';
import { makeSlice, sliceTemplate, waitFor } from './_m1a-slice.js';
import { writeSyntheticExport } from './_m2-lifecycle.js';
import { archiveRoot, walkHistory } from './_m2-w25.js';
import { contentOf, filler, runTurn } from './_compaction.js';

takeIntegrationLock(test, 'compaction archive test');

const run = integrationEnabled ? test.serial : test.skip;

/** Imported turns of the long session. */
const LONG_TURNS = 300;

const counts = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** @param {number} usedTokens */
const usage = usedTokens => ({
  ...counts,
  context: { usedTokens, windowTokens: 100 },
});

/**
 * A script: `over` reads 80 of 100 (the next turn asks), the named long
 * turns carry text, every other turn reads 10 of 100.
 */
const script = harden({
  turns: [
    {
      input: 'over',
      rounds: [{ chunks: [{ text: 'over' }], usage: usage(80) }],
    },
    {
      input: 'big one',
      rounds: [{ chunks: [{ text: filler('one', 6000) }], usage: usage(30) }],
    },
    {
      input: 'big two',
      rounds: [{ chunks: [{ text: filler('two', 6000) }], usage: usage(80) }],
    },
    { rounds: [{ chunks: [{ text: 'a reply' }], usage: usage(10) }] },
  ],
});

/** @param {string} text */
const sha16 = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The digest of the summary message the projection puts first. */
const summaryDigest = sha16(
  JSON.stringify({
    kind: 'message',
    role: 'assistant',
    content: scriptedSummary,
  }),
);

/**
 * The per-turn digests of a turn's round-0 `context` line.
 * @param {any} made
 * @param {string} turnId
 * @returns {string[]}
 */
const digestsOf = (made, turnId) =>
  made
    .log()
    .find(
      (/** @type {any} */ l) =>
        l.kind === 'context' && l.turnId === turnId && l.round === 0,
    )
    ?.turnDigests.split(' ') ?? [];

/**
 * The single archive directory of a state (one archived session).
 * @param {string} root
 */
const archiveDirOf = root => {
  const base = archiveRoot(root);
  const dirs = existsSync(base)
    ? readdirSync(base).filter(name =>
        existsSync(path.join(base, name, 'manifest.json')),
      )
    : [];
  return dirs.length === 1 ? path.join(base, dirs[0]) : undefined;
};

/** @param {string} file */
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/** @param {string} dir */
const contextHead = dir => {
  const file = path.join(dir, 'context.jsonl');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
};

run(
  '9: a 300-turn imported session compacts, is killed and restarted: same context, archive at the boundary, history from turn 1',
  async t => {
    t.timeout(4.5 * 60_000);
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(script);
    const file = path.join(tmpRoot, `${shortName('x')}.jsonl`);
    t.teardown(() => rm(file, { force: true }));
    await writeSyntheticExport(file, [
      {
        title: 'long',
        turns: LONG_TURNS,
        backendLabel: 'Scripted',
        shape: 'plain',
      },
    ]);
    const imported = await importState({
      client: state.client,
      file,
      backends: [made.backend],
    });
    const [session] = imported.sessions;
    const { key } = await E(session).getInfo();
    let live = await slice.subscribe(session);
    const sealedBefore = (await E(session).getHistoryPage()).archive;
    t.true(Number(sealedBefore?.segments ?? 0) > 0, 'segments sealed');

    await runTurn(slice, session, live, 'over');
    const compacting = await runTurn(slice, session, live, 'compact me');
    const records = await contentOf(compacting.turn);
    const compaction = records.find(r => r.kind === 'compaction');
    t.truthy(compaction, `records ${records.map(r => r.kind).join(', ')}`);
    const started = records.find(r => r.kind === 'compaction-started');
    const sealedTo = Number(
      (await E(session).getHistoryPage()).archive?.sealedTo ?? 0,
    );
    t.true(
      Number(compaction.boundary) >= sealedTo,
      'the boundary is in the kept records',
    );
    t.true(Number(compaction.boundary) > Number(started.boundary));
    const compacted = digestsOf(made, compacting.turnId);
    t.is(
      compacted[0],
      summaryDigest,
      'the compacted round starts with the summary',
    );
    t.true(
      compacted.length < LONG_TURNS / 2,
      `the tail is part of the history (${compacted.length} turns)`,
    );

    // The archive reconciles to the vat's epoch and boundary (off the
    // round's path).
    const dir = await waitFor(
      () => {
        const found = archiveDirOf(state.root);
        if (found === undefined) return undefined;
        const manifest = readJson(path.join(found, 'manifest.json'));
        return manifest.epoch === 1 && manifest.boundary === compaction.boundary
          ? found
          : undefined;
      },
      30_000,
      'the manifest at the new epoch',
    );
    t.like(contextHead(dir), { epoch: 1, boundary: compaction.boundary });

    const beforeKill = await runTurn(slice, session, live, 'before kill');
    const before = digestsOf(made, beforeKill.turnId);
    t.is(before[0], summaryDigest);

    await live.stop();
    await state.kill();
    await state.restart();
    await slice.refresh();
    const again = await E(slice.factory).findSession(key);
    live = await slice.subscribe(again);
    t.teardown(() => live.stop());
    const afterKill = await runTurn(slice, again, live, 'after restart');
    const after = digestsOf(made, afterKill.turnId);
    // The same context: every turn group before `before kill` (whose own
    // group gained its reply since) is the same.
    t.deepEqual(after.slice(0, before.length - 1), before.slice(0, -1));
    t.is(after.length, before.length + 1);
    t.like(readJson(path.join(dir, 'manifest.json')), {
      epoch: 1,
      boundary: compaction.boundary,
    });

    const history = await E(slice.admin).history();
    const { seen } = await walkHistory(again, history);
    t.is(seen.length, LONG_TURNS + 4, 'every turn, imported and live');
    t.is(seen.at(-1), 't1', 'history reaches turn 1');
    t.is(new Set(seen).size, seen.length);
  },
);

run(
  '10: export then import of a compacted session sends the same summary and tail',
  async t => {
    t.timeout(4 * 60_000);
    const template = await sliceTemplate();
    const source = await startFromTemplate(template, { t });
    const slice = await makeSlice(source);
    const made = await slice.makeBackend(script);
    const session = await slice.createSession(made.backend, 'export');
    const live = await slice.subscribe(session);
    t.teardown(() => live.stop());
    await runTurn(slice, session, live, 'big one');
    await runTurn(slice, session, live, 'big two');
    const third = await runTurn(slice, session, live, 'after');
    t.truthy(
      (await contentOf(third.turn)).find(r => r.kind === 'compaction'),
      'compacted',
    );

    const file = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    t.teardown(() => rm(file, { force: true }));
    await exportState({ client: source.client, file });

    const target = await startFromTemplate(template, { t });
    const targetSlice = await makeSlice(target);
    const targetMade = await targetSlice.makeBackend(script);
    const imported = await importState({
      client: target.client,
      file,
      backends: [targetMade.backend],
    });
    const [copy] = imported.sessions;
    const copyLive = await targetSlice.subscribe(copy);
    t.teardown(() => copyLive.stop());

    const sourceProbe = await runTurn(slice, session, live, 'probe');
    const copyProbe = await runTurn(targetSlice, copy, copyLive, 'probe');
    const want = digestsOf(made, sourceProbe.turnId);
    const got = digestsOf(targetMade, copyProbe.turnId);
    t.is(want[0], summaryDigest);
    t.deepEqual(got, want, 'the same summary and tail');
  },
);
