// @ts-check
/**
 * The factory's `Voice` across a SIGKILL of the supervisor
 * (designs/m11-interfaces.md 8, kill points K11-3, K11-4 and K11-5;
 * acceptance 13's "the claim survives a restart"; W11.7), from the m1a
 * state template with a scripted backend:
 *
 * - K11-3: killed inside `setPreferences`: afterwards `getPreferences`
 *   answers the old or the new record, never a mix.
 * - K11-5: killed after the creation and the claim: the redelivered launch
 *   answers the same session with `duplicate: true`.
 * - K11-4: killed while the creation of a claimed launch runs: the start
 *   listener completes or rolls it back; the redelivered launch answers a
 *   ready session, at most one extra session is listed (O-8), and a third
 *   delivery answers the claimed one.
 *
 * K11-1, K11-2 and acceptance 21 need the speech host and its engines
 * (W11.1, W11.5); they join this file when those land.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/voice-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { E } from '@endo/far';

import { emit } from '../../perf/_harness.mjs';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { waitFor } from './_m1a-slice.js';
import { open, operatorOf } from './_m5-presets.js';

takeIntegrationLock(test, 'voice restart test');

const run = integrationEnabled ? test.serial : test.skip;

/**
 * The slice's Voice after a (re)connection.
 * @param {any} slice
 */
const voiceOf = async slice => E((await operatorOf(slice)).operator).getVoice();

run(
  'K11-3, K11-5, K11-4: preferences, a made claim and a claim cut off inside its creation, across a SIGKILL',
  async t => {
    t.timeout(4 * 60_000);
    const { state, slice, backend } = await open(t);
    let voice = await voiceOf(slice);
    const { catalog } = await operatorOf(slice);
    const { revision } = await E(catalog).configuration();
    const { preset } = await E(catalog).create(
      harden({ label: 'Talker', template: 'general', backend }),
      revision,
    );
    await E(voice).setVoicePreset(preset, revision + 1);
    const old = harden({ speed: 1.5, voice: 'en_old' });
    await E(voice).setPreferences(old);
    const made = await E(voice).startVoiceSession(
      harden({ invocationId: 'launch-made', at: Date.now() }),
    );

    // K11-3 with K11-5: the write in flight when the supervisor dies.
    const next = harden({ speed: 0.75, voice: 'en_new', noiseW: 1 });
    void E(voice)
      .setPreferences(next)
      .catch(() => undefined);
    await state.kill();
    await state.restart();
    await slice.refresh();
    voice = await voiceOf(slice);
    const after = await E(voice).getPreferences();
    const wasNew = after.voice === 'en_new';
    t.deepEqual(after, wasNew ? next : old, 'the old or the new record');
    const again = await E(voice).startVoiceSession(
      harden({ invocationId: 'launch-made' }),
    );
    t.true(again.duplicate, 'K11-5: the claim survived');
    t.is(again.key, made.key);
    t.like(await E(again.session).getInfo(), { presetLabel: 'Talker' });
    t.is(
      (await E(await E(voice).getVoicePreset()).describe()).label,
      'Talker',
      'the shortcut preset survived',
    );

    // K11-4: killed while the claimed creation runs.
    const listed = async () => (await E(slice.factory).listSessions()).rows;
    const before = (await listed()).length;
    const workers = new Set(
      (await slice.workers()).map((/** @type {any} */ w) => w.workerId),
    );
    const c0 = Date.now();
    void E(voice)
      .startVoiceSession(harden({ invocationId: 'launch-cut', at: c0 }))
      .catch(() => undefined);
    await waitFor(
      async () =>
        Date.now() - c0 > 300 ||
        (await slice.workers()).some(
          (/** @type {any} */ w) => !workers.has(w.workerId),
        ),
      30_000,
      'a new vat or 300 ms',
      20,
    );
    await state.kill();
    await state.restart();
    await slice.refresh();
    voice = await voiceOf(slice);
    await waitFor(
      async () => {
        const status = await E(slice.harness).status();
        return status.sessions === (await listed()).length;
      },
      30_000,
      'no half-made row',
    );
    const redelivered = await E(voice).startVoiceSession(
      harden({ invocationId: 'launch-cut', at: Date.now() }),
    );
    const rows = await listed();
    t.true(rows.every((/** @type {any} */ r) => r.state === 'ready'));
    t.true(
      rows.length - before >= 1 && rows.length - before <= 2,
      `at most one extra listed session (O-8): ${rows.length - before}`,
    );
    t.true(rows.some((/** @type {any} */ r) => r.key === redelivered.key));
    const third = await E(voice).startVoiceSession(
      harden({ invocationId: 'launch-cut' }),
    );
    t.true(third.duplicate);
    t.is(third.key, redelivered.key, 'one claimed session');
    emit({
      check: 'voice-restart',
      preferencesAfterKill: wasNew ? 'new' : 'old',
      cutLaunch: redelivered.duplicate ? 'completed' : 're-run',
      extraSessions: rows.length - before - 1,
      by: 'W11.7',
    });
  },
);
