// @ts-check
/**
 * M5 acceptance 9 without the preset-instructions part (W5.2;
 * m5-interfaces.md 2.3.1 and 8.1; R4-26, R4-27, R4-28, R5-52) through the
 * daemon, on the scripted backend, from the m1a state template (the real
 * factory and session programs in vats):
 *
 * - a typed session's requests carry the composed prompt with the plain
 *   introduction, a spoken session's the spoken introduction; both carry
 *   M5's guest section (the persistent scope and the per-call `powers`);
 *   every round of every turn carries the same prompt (composed once);
 * - a `systemPrompt` option replaces the composition;
 * - a blank `systemPrompt` fails the creation.
 *
 * The prompt is compared by the scripted provider's `context` line
 * (`systemDigest`, `systemBytes`) against `composeSystemPrompt` in Node.
 * Part 7 (preset instructions) is W5.9's acceptance 1 (it needs W5.1's
 * user presets).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/m5-prompt.test.js
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';

takeIntegrationLock(test, 'm5 prompt test');

const run = integrationEnabled ? test.serial : test.skip;

const script = harden({
  turns: [
    {
      input: 'two rounds',
      rounds: [
        { toolCalls: [{ name: 'echo', args: '{"text":"x"}' }] },
        { chunks: [{ text: 'done' }] },
      ],
    },
    { input: 'again', rounds: [{ chunks: [{ text: 'ok' }] }] },
  ],
});

/** @param {string} text */
const sha16 = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

run(
  '9: plain and spoken introductions, M5 guest section, a given prompt replaces, a blank one fails',
  async t => {
    t.timeout(4 * 60_000);
    const t0 = performance.now();
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const ready = performance.now();

    /**
     * A session on its own scripted backend (its own log).
     * @param {Record<string, any>} extra CreateOptions fields
     */
    const sessionWith = async extra => {
      const made = await slice.makeBackend(script);
      const session = await E(slice.factory).createSession(
        harden({
          title: 'p',
          preset: slice.chatOnly,
          backend: made.backend,
          at: Date.now(),
          ...extra,
        }),
      );
      return { session, log: made.log };
    };

    /**
     * Run one turn to its end.
     * @param {any} session
     * @param {string} text
     */
    const turn = async (session, text) => {
      const receipt = await slice.submit(session, text);
      const started = await waitFor(
        async () =>
          (await E(session).getSubmissionReceipt(receipt.requestId))?.turn,
        30_000,
        `the turn for ${text}`,
      );
      t.is((await E(started).whenFinished()).state, 'completed', text);
    };

    /**
     * Every `context` line carries `expected` (R4-28: composed once).
     * @param {() => any[]} log
     * @param {string} expected
     * @param {string} what
     */
    const promptIs = (log, expected, what) => {
      const contexts = log().filter(l => l.kind === 'context');
      t.is(contexts.length, 3, `${what}: two rounds, then one`);
      for (const line of contexts) {
        t.is(line.systemDigest, sha16(expected), what);
        t.is(line.systemBytes, Buffer.byteLength(expected), what);
      }
    };

    const plain = composeSystemPrompt({ spoken: false });
    const spoken = composeSystemPrompt({ spoken: true });
    t.not(plain, spoken);
    // What the model is told about the scope and `powers` (part 2).
    t.regex(plain, /one scope that persists/);
    t.regex(plain, /`powers` is that call's view of your\npetstore/);
    t.regex(plain, /they belong to that call/);

    const typed = await sessionWith({});
    await turn(typed.session, 'two rounds');
    await turn(typed.session, 'again');
    promptIs(typed.log, plain, 'typed');

    const voiced = await sessionWith({ spoken: true });
    await turn(voiced.session, 'two rounds');
    await turn(voiced.session, 'again');
    promptIs(voiced.log, spoken, 'spoken');

    const given = 'You answer in one word.';
    const replaced = await sessionWith({ systemPrompt: given, spoken: true });
    await turn(replaced.session, 'two rounds');
    await turn(replaced.session, 'again');
    promptIs(replaced.log, given, 'given');

    const before = (await E(slice.factory).listSessions()).rows.length;
    for (const systemPrompt of ['', '  \n']) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => sessionWith({ systemPrompt }), {
        message: texts.blankSystemPrompt,
      });
    }
    t.is(
      (await E(slice.factory).listSessions()).rows.length,
      before,
      'no row for a refused creation',
    );

    emit({
      check: 'm5-prompt',
      setupMs: round1(ready - t0),
      totalMs: round1(performance.now() - t0),
      plainBytes: Buffer.byteLength(plain),
      spokenBytes: Buffer.byteLength(spoken),
    });
  },
);
