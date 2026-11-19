// @ts-check
/**
 * M5 acceptance 10, untrusted answers and the membrane (W5.5;
 * designs/m5-interfaces.md 8.1 item 10, D-M5-2, D-M5-3), in a real daemon
 * on the m5o template (fixture objects in the workspace vat):
 *
 * - exec code sends a 100 KiB string to an endowed fixture through the
 *   membrane: refused in the exec vat with `textOf.membraneTooLarge`, and
 *   the fixture's vat answers its next call (the write never arrived);
 * - a record of 40 keys is refused (`textOf.membraneTooManyKeys`);
 * - a granted tool answering 300 KB yields a staged, cut result,
 *   `texts.inspectTerminated`, or (the hub refused the answer for size)
 *   the inspector's `ANSWER_OVER_FRAME_TEXT`, and the session keeps working
 *   (its next turn completes and no vat but an exec vat stopped).
 *
 *   THIX_AGENT=W5.5 corepack yarn test:integration test/integration/m5-security.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { emit, loadAvg, runIdentity } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, waitFor } from './_m1a-slice.js';
import { isStaged, runTurn, turnRecords } from './_m1b.js';
import {
  call,
  closing,
  endowedPreset,
  exec,
  fixturesOf,
  objectsTemplate,
  presetSession,
  tooBigOutcome,
  turnOf,
} from './_m5-objects.js';

takeIntegrationLock(test, 'm5 security test');

const run = integrationEnabled ? test.serial : test.skip;

const BIG = 100 * 1024;

const script = harden({
  turns: [
    turnOf('membrane', [
      exec(
        `const n = await E(powers).lookup('notes'); try { await E(n).write('x'.repeat(${BIG})); return 'sent'; } catch (e) { return e.message; }`,
      ),
      exec("const n = await E(powers).lookup('notes'); return E(n).read();"),
      exec(
        "const c = await E(powers).lookup('calc'); const r = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i])); try { await E(c).add(r, 1); return 'sent'; } catch (e) { return e.message; }",
      ),
      exec("const c = await E(powers).lookup('calc'); return E(c).add(2, 3);"),
    ]),
    { input: 'warm', rounds: [closing] },
    turnOf('big answer', [call('bigAnswer', { text: 'x' })]),
    turnOf('after', [call('list', {}), exec('return 1;')]),
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

run('acceptance 10: the membrane and untrusted answers', async t => {
  t.timeout(4 * 60_000);
  const template = await objectsTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const identity = { ...(await runIdentity()), loadAvg: loadAvg() };
  const fixtures = await fixturesOf(state);
  const made = await slice.makeBackend(script);
  const preset = await endowedPreset(
    slice,
    { notes: fixtures.notes, calc: fixtures.calc },
    { label: 'Security', backend: made.backend },
  );
  const session = await presetSession(slice, preset, made.backend, 'm5 sec');
  const live = await slice.subscribe(session);

  // ---- the membrane: 100 KiB and 40 keys refused before they leave
  const membrane = await runTurn(slice, session, live, 'membrane');
  t.is(membrane.end.status, 'completed');
  const [tooLarge, readBack, tooManyKeys, added] = await resultsOf(
    membrane.turn,
  );
  t.false(tooLarge[1]);
  const largeText = JSON.parse(tooLarge[0]);
  const prefix = textOf.membraneTooLarge(0, limits.membraneArgBytes);
  t.true(
    largeText.startsWith(prefix.slice(0, prefix.indexOf('0'))) &&
      largeText.includes(`limit ${limits.membraneArgBytes}`),
    largeText,
  );
  t.deepEqual(readBack, [rendered('remember the milk'), false]);
  t.deepEqual(tooManyKeys, [
    rendered(textOf.membraneTooManyKeys(40, limits.membraneRecordKeys)),
    false,
  ]);
  t.deepEqual(added, ['5', false]);
  t.false(
    (await E(fixtures.notes).calls()).includes('write'),
    'the refused write never reached the fixture',
  );

  // ---- a granted tool answering 300 KB
  const grants = await E(session).grants();
  const grant = await E(grants).grantTool(fixtures.bigAnswerTool);
  const warm = await runTurn(slice, session, live, 'warm');
  t.is(warm.end.status, 'completed');
  const info = await waitFor(
    async () => {
      const described = await E(grant).describe();
      return described.state === 'pending' ? undefined : described;
    },
    30_000,
    'the grant schema read',
  );
  t.is(info.state, 'offered', JSON.stringify(info));
  const big = await runTurn(slice, session, live, 'big answer', 120_000);
  t.is(big.end.status, 'completed');
  const [answer] = await resultsOf(big.turn);
  // Since core CC-027 the hub refuses the 300 KB answer's frame toward the
  // exec vat (over THIXOTROPE_VAT_FRAME_BYTES) before the vat decodes it:
  // the exec vat's call breaks with the hub's FRAME_TOO_LARGE and the tool
  // answers ANSWER_OVER_FRAME_TEXT. Also no halt (J-10124).
  const outcome = tooBigOutcome(answer[0]);
  t.not(outcome, undefined, JSON.stringify(answer).slice(0, 300));
  t.not(outcome, 'helpUnavailable', 'a granted answer is not a describe');
  if (outcome === 'staged') {
    t.false(answer[1], JSON.stringify(answer).slice(0, 300));
    t.true(isStaged(answer[0]), 'the cut answer is staged');
    t.true(Number(answer[0].bytes) <= 3 * limits.toolOutputUnits);
    t.true(answer[0].preview.startsWith('yyy'));
  } else {
    t.true(answer[1], 'a stopped vat or a refused answer is a failed result');
  }
  emit({
    metric: 'm5.security.bigGrantedAnswer',
    outcome,
    bytes: outcome === 'staged' ? answer[0].bytes : undefined,
    ...identity,
  });

  // ---- the session keeps working
  const after = await runTurn(slice, session, live, 'after');
  t.is(after.end.status, 'completed');
  t.deepEqual(await resultsOf(after.turn), [
    [rendered(['calc', 'notes']), false],
    ['1', false],
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
  await live.stop();
});
