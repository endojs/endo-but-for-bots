// @ts-check
/**
 * M5 acceptance 3 (remote rendering), 4, 5, 8 and kill point K7 (W5.5;
 * designs/m5-interfaces.md 8.1, section 5), in a real daemon on the m5o
 * template (the m1b provisioning plus the M5 fixture step: the fixture
 * objects live in the workspace vat).
 *
 * - 8: a user preset endowing inventory rows `notes`, `calc`, `src` and
 *   `bigHelp`; its session lists them; endowment labels `user` and `a/b`,
 *   33 endowments, a duplicate and a `chat-only` record with an endowment
 *   are refused;
 * - 3: `lookup` of an endowed object renders `[remote capability] callable
 *   methods: [...]` and calls none of its methods (the fixture's log);
 * - 4: in one turn `store` by tool, then exec `E(powers).lookup('x')` sees
 *   it; `remove` by tool, then exec sees it gone; an undeclared name reads
 *   as `undefined` (J-0472); an endowed object is called through the
 *   membrane; `powers` kept on `globalThis` rejects with `powersExpired` in
 *   the next turn; `globalThis.y` survives the turn and a SIGKILL restart;
 * - K7: SIGKILL during an exec call that would await `powers.lookup`: the
 *   turn is outcome-unknown, that call's `powers` stays dead, the next
 *   call's works;
 * - 5: `describeCapability` (overview and one method) and `readSources`
 *   with a search; a fixture whose `help()` answers 200 KB gives a cut,
 *   staged result, `texts.inspectTerminated` (the contract expected the
 *   latter; this worker decodes the answer, J-0771) or, since core CC-027,
 *   the methods with documentation `unavailable` (the hub refused the
 *   help() answer for size), and the session's next turn runs normally.
 *
 *   THIX_AGENT=W5.5 corepack yarn test:integration test/integration/m5-objects.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  killStrays,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, waitFor } from './_m1a-slice.js';
import { resultsOf as historyResults } from './_m1b-exec.js';
import { isStaged, runTurn, turnRecords } from './_m1b.js';
import {
  call,
  endowedPreset,
  exec,
  fixturesOf,
  objectsTemplate,
  operatorOf,
  presetSession,
  tooBigOutcome,
  turnOf,
} from './_m5-objects.js';

takeIntegrationLock(test, 'm5 objects test');

const run = integrationEnabled ? test.serial : test.skip;

const K7_CODE =
  "globalThis.kp = powers; await sleep(4000); await E(powers).lookup('notes'); return 1;";

const script = harden({
  turns: [
    turnOf('objects', [
      call('list', {}),
      call('lookup', { petName: 'notes' }),
      call('lookup', { petName: 'notes' }),
    ]),
    turnOf('powers', [
      call('store', { value: { a: 1 }, petName: 'x' }),
      exec("const v = await E(powers).lookup('x'); return v.a;"),
      call('remove', { petName: 'x' }),
      exec(
        "globalThis.keep = powers; globalThis.y = 7; return (await E(powers).lookup('x')) === undefined;",
      ),
      exec('const r = zz; return r === undefined;'),
      exec("const n = await E(powers).lookup('notes'); return E(n).read();"),
    ]),
    turnOf('publish counter', [
      exec(
        "let n = 0; await powers.publish('counter', { increment() { return ++n; }, async unavailable() { throw Error('private detail'); } }); return true;",
      ),
    ]),
    turnOf('call counter', [
      exec(
        "const c = await powers.lookup('counter'); return E(c).increment();",
      ),
      exec(
        "const c = await powers.lookup('counter'); return E(c).increment();",
      ),
      exec(
        "const c = await powers.lookup('counter'); try { await E(c).unavailable(); return false; } catch (error) {return !error.message.includes('private detail');}",
      ),
      call('remove', { petName: 'counter' }),
    ]),
    turnOf('expired', [
      exec(
        "try { await keep.lookup('notes'); return 'live'; } catch (e) { return e.message; }",
      ),
    ]),
    turnOf('k7', [exec(K7_CODE)]),
    turnOf('k7 after', [
      exec(
        "try { await kp.list(); return 'live'; } catch (e) { return e.message; }",
      ),
      exec('return [y, (await E(powers).list()).length];'),
    ]),
    turnOf('describe', [
      call('describeCapability', { petName: 'notes' }),
      call('describeCapability', { petName: 'notes', method: 'read' }),
      call('readSources', {
        petName: 'src',
        items: [
          { path: ['src', 'agent.js'], search: 'checkpoint' },
          { path: ['missing.md'] },
        ],
      }),
      call('describeCapability', { petName: 'bigHelp' }),
    ]),
    turnOf('after', [call('list', {}), exec('return typeof y;')]),
  ],
});

/**
 * The tool results of a turn, in call order: `[result, failed]`.
 * @param {any} turn
 */
const resultsOf = async turn =>
  (await turnRecords(turn))
    .filter(r => r.kind === 'tool-result')
    .map(r => [r.result, r.failed]);

/** @param {unknown} value */
const rendered = value => JSON.stringify(value, null, 2);

run('acceptance 3 (remote), 4, 5, 8 and K7', async t => {
  t.timeout(5 * 60_000);
  const t0 = performance.now();
  const template = await objectsTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const identity = { ...(await runIdentity()), loadAvg: loadAvg() };
  const fixtures = await fixturesOf(state);
  const made = await slice.makeBackend(script);
  const { backend } = made;

  // ---- 8: endowment refusals at the catalogue
  const { catalog } = await operatorOf(slice);
  /**
   * @param {any} record
   * @param {any} expected
   */
  const refused = async (record, expected) => {
    const { revision } = await E(catalog).configuration();
    await t.throwsAsync(E(catalog).create(harden(record), revision), expected);
  };
  const endow = (/** @type {string} */ label) =>
    harden({ label, value: fixtures.notes });
  await refused(
    { label: 'R1', template: 'general', backend, endowments: [endow('user')] },
    { message: textOf.reservedEndowment('user') },
  );
  await refused(
    { label: 'R2', template: 'general', backend, endowments: [endow('a/b')] },
    { message: textOf.reservedEndowment('a/b') },
  );
  await refused(
    {
      label: 'R3',
      template: 'general',
      backend,
      endowments: Array.from({ length: limits.maxEndowments + 1 }, (_, i) =>
        endow(`e${i}`),
      ),
    },
    undefined,
  );
  await refused(
    {
      label: 'R4',
      template: 'general',
      backend,
      endowments: [endow('n'), endow('n')],
    },
    { message: textOf.duplicateEndowment('n') },
  );
  await refused(
    { label: 'R5', template: 'chat-only', backend, endowments: [endow('n')] },
    { message: texts.chatOnlyRule },
  );

  const preset = await endowedPreset(
    slice,
    {
      notes: fixtures.notes,
      calc: fixtures.calc,
      src: fixtures.sourceReader,
      bigHelp: fixtures.bigHelp,
    },
    { label: 'Objects', backend },
  );
  let session = await presetSession(slice, preset, backend);
  const { key } = await E(session).getInfo();
  let live = await slice.subscribe(session);

  // ---- 8 and 3: the session lists the endowments; lookup renders
  const callsBefore = await E(fixtures.notes).calls();
  // eslint-disable-next-line no-underscore-dangle
  const noteMethods = await E(fixtures.notes).__getMethodNames__();
  const objects = await runTurn(slice, session, live, 'objects');
  t.is(objects.end.status, 'completed');
  const line = `[remote capability] callable methods: ${JSON.stringify(noteMethods)}`;
  t.deepEqual(await resultsOf(objects.turn), [
    [rendered(['bigHelp', 'calc', 'notes', 'src']), false],
    [line, false],
    [line, false],
  ]);
  t.deepEqual(
    await E(fixtures.notes).calls(),
    callsBefore,
    'lookup called no method of notes',
  );

  // ---- 4: powers sees the tool's store and remove in the same turn
  const powers = await runTurn(slice, session, live, 'powers');
  t.is(powers.end.status, 'completed');
  const powersResults = await resultsOf(powers.turn);
  t.deepEqual(powersResults.slice(0, 4), [
    [textOf.stored('x'), false],
    ['1', false],
    [textOf.removed('x'), false],
    ['true', false],
  ]);
  // J-0472: an undeclared name reads as undefined (recorded either way).
  const undeclared = powersResults[4];
  emit({ metric: 'm5.exec.undeclaredName', result: undeclared, ...identity });
  t.deepEqual(undeclared, ['true', false], 'an undeclared name is undefined');
  t.deepEqual(powersResults[5], [rendered('remember the milk'), false]);
  t.true((await E(fixtures.notes).calls()).includes('read'));

  const published = await runTurn(slice, session, live, 'publish counter');
  t.deepEqual(await resultsOf(published.turn), [['true', false]]);
  const invoked = await runTurn(slice, session, live, 'call counter');
  t.deepEqual(await resultsOf(invoked.turn), [
    ['1', false],
    ['2', false],
    ['true', false],
    [textOf.removed('counter'), false],
  ]);

  const expired = await runTurn(slice, session, live, 'expired');
  t.deepEqual(await resultsOf(expired.turn), [
    [rendered(texts.powersExpired), false],
  ]);

  // ---- K7: SIGKILL while an exec call sleeps before its powers.lookup
  const from = live.deliveries.length;
  const receipt = await slice.submit(session, 'k7');
  const { turnId } = await E(receipt.turn).getStatus();
  await waitFor(
    () =>
      live.deliveries.find(
        (d, i) =>
          i >= from &&
          d.event.type === 'tool_call' &&
          d.event.turnId === turnId,
      ),
    60_000,
    'k7: tool_call',
    10,
  );
  await delay(1500);
  await live.stop();
  await state.kill();
  await killStrays(state.root);
  const restarted = await state.restart();
  await slice.refresh();
  session = await E(slice.factory).findSession(key);
  live = await slice.subscribe(session);
  const k7 = await waitFor(
    async () => {
      const r = await historyResults(session, turnId);
      return r.state === 'outcome-unknown' ? r : undefined;
    },
    30_000,
    'k7: outcome-unknown',
  );
  t.deepEqual(k7.results, [texts.toolOutcomeUnknown]);
  const after = await runTurn(slice, session, live, 'k7 after');
  t.is(after.end.status, 'completed');
  t.deepEqual(await resultsOf(after.turn), [
    [rendered(texts.powersExpired), false],
    [rendered([7, 4]), false],
  ]);
  emit({
    metric: 'm5.objects.k7.restart',
    servedMs: restarted.servedMs,
    ...identity,
  });

  // ---- 5: describeCapability, readSources, a 200 KB help
  const d0 = performance.now();
  const described = await runTurn(slice, session, live, 'describe', 120_000);
  const describeMs = round1(performance.now() - d0);
  t.is(described.end.status, 'completed');
  const [overview, method, sources, big] = await resultsOf(described.turn);
  t.false(overview[1]);
  t.like(JSON.parse(overview[0]), {
    methods: noteMethods,
    documentation: 'notes: read() answers the note; write(text) replaces it.',
    documentationScope: 'overview',
    truncated: false,
  });
  t.like(JSON.parse(method[0]), {
    documentation: 'notes.read: see read() and write(text).',
    documentationScope: 'method',
  });
  t.false(sources[1]);
  t.deepEqual(JSON.parse(sources[0]), {
    results: [
      {
        index: 0,
        ok: true,
        lines: [
          { line: 3, text: '  checkpoint();' },
          { line: 6, text: 'const checkpoint = () => undefined;' },
        ],
        scanTruncated: false,
        outputTruncated: false,
      },
      { index: 1, ok: false, error: 'No such file' },
    ],
  });
  // 200 KB help: either the exec vat decoded it and the inspector cut and
  // staged it (no halt at this worker), or the exec vat stopped and the
  // session said so (J-0771), or (since core CC-027) the hub refused the
  // help's frame toward the exec vat (over THIXOTROPE_VAT_FRAME_BYTES)
  // before the vat decoded it, the help() call broke and describeCapability
  // shows the methods with documentation `unavailable` (helpUnavailable).
  // All keep the session working; no halt (J-10124).
  const outcome = tooBigOutcome(big[0]);
  t.not(outcome, undefined, JSON.stringify(big).slice(0, 300));
  const terminated = outcome === 'inspectTerminated';
  if (outcome === 'staged') {
    t.false(big[1]);
    t.true(isStaged(big[0]), 'a cut answer over inlineBytes is staged');
    t.true(Number(big[0].bytes) <= 3 * limits.inspectResultUnits);
    t.true(big[0].preview.startsWith('{"methods":'));
  } else if (outcome === 'helpUnavailable') {
    t.false(big[1], 'a refused help() keeps an ok result with the methods');
  } else {
    t.true(big[1], 'a stopped vat or a refused answer is a failed result');
  }
  emit({
    metric: 'm5.objects.bigHelp',
    outcome,
    bytes: outcome === 'staged' ? big[0].bytes : undefined,
    ...identity,
  });

  const next = await runTurn(slice, session, live, 'after');
  t.is(next.end.status, 'completed');
  t.deepEqual(await resultsOf(next.turn), [
    [rendered(['bigHelp', 'calc', 'notes', 'src']), false],
    // A lost exec vat takes its scope: a fresh scope has no `y`.
    [rendered(terminated ? 'undefined' : 'number'), false],
  ]);
  const halted = (await slice.workers()).filter(
    (/** @type {any} */ w) =>
      w.failure && !/^(spare )?exec \d+$/.test(w.debugLabel ?? ''),
  );
  t.deepEqual(
    halted.map((/** @type {any} */ w) => w.debugLabel),
    [],
    'only an exec vat may stop',
  );
  emit({
    metric: 'm5.objects.describeTurn',
    turnMs: describeMs,
    wallMs: round1(performance.now() - t0),
    ...identity,
  });
  await live.stop();
});
