// @ts-check
/**
 * The factory's `Voice` through the daemon (designs/m11-interfaces.md 13:
 * acceptance 8, 9, 13, 14, 19, 22 and the 14.2 probes of `setPreferences`
 * and of `configureSpeech` on a `Voice` presence; W11.7), from the m1a
 * state template (the real factory and session programs in vats), with
 * scripted backends and, for G-11, the fake provider server's catalogue on
 * 127.0.0.1:
 *
 *  8. preferences written by client A are what client B reads; a stale
 *     `setVoicePreset` revision is refused; Talk creates the session from
 *     the chosen preset.
 *  9. a session from `startVoiceSession` gets the spoken introduction, a
 *     typed one the plain one (the scripted provider's `context` lines).
 * 13. the same invocation id twice answers one session, `duplicate: true`.
 * 14. G-11: the shortcut preset pinned to a model its backend's catalogue
 *     lacks makes the session on the factory default with the warning.
 * 19. a client finds no `configureSpeech` on `Voice`; the provisioning
 *     step's `HarnessRoot.configureSpeech` changes the settings revision.
 * 22. with the built-in `voice` preset unavailable (no environment runner
 *     before M6), Talk is refused with its `unavailableReason` and lists no
 *     session.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/voice-session.test.js
 */
import '../unit/_m1a-prelude.js';

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { composeSystemPrompt } from '../../guest/lib/system-prompt-base.js';
import { voiceTextOf, voiceTexts } from '../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { names } from '../../scripts/provision-steps.js';
import { voiceStep } from '../../scripts/provision-steps/70-voice.js';
import { startFakeProviderServer } from '../fixtures/fake-provider-server.mjs';
import {
  TEMPLATE_WORKSPACE,
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';
import { makeTestSecretValue, replaceSealed } from './_m2-secrets.js';
import { operatorOf } from './_m5-presets.js';

takeIntegrationLock(test, 'voice session test');

const run = integrationEnabled ? test.serial : test.skip;

const script = harden({
  turns: [{ input: 'hello', rounds: [{ chunks: [{ text: 'Hi there.' }] }] }],
});

/** @param {string} text */
const sha16 = text =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Run one turn to its end and answer the provider's `context` lines.
 * @param {any} slice
 * @param {any} session
 * @param {() => any[]} log
 */
const promptsOf = async (slice, session, log) => {
  const receipt = await slice.submit(session, 'hello');
  const turn = await waitFor(
    async () =>
      (await E(session).getSubmissionReceipt(receipt.requestId))?.turn,
    30_000,
    'the turn',
  );
  await E(turn).whenFinished();
  return log().filter(line => line.kind === 'context');
};

/**
 * A user preset of the `general` template (no object: available).
 * @param {any} catalog
 * @param {Record<string, any>} fields
 */
const createPreset = async (catalog, fields) => {
  const { revision } = await E(catalog).configuration();
  const { preset } = await E(catalog).create(
    harden({ template: 'general', ...fields }),
    revision,
  );
  return preset;
};

run(
  '8, 9, 13, 19, 22: shared preferences, settings authority, Talk from the chosen preset, a duplicate launch',
  async t => {
    t.timeout(4 * 60_000);
    const t0 = performance.now();
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const ready = performance.now();
    const a = await operatorOf(slice);
    const voiceA = await E(a.operator).getVoice();
    const clientB = await state.connect({ workspace: TEMPLATE_WORKSPACE });
    t.teardown(() => clientB.close());
    const harnessB = await clientB.call('lookup', names.harness);
    const voiceB = await E(E(harnessB).getOperator()).getVoice();

    // 8: A writes, B reads; refusals change nothing (14.2).
    const p0 = performance.now();
    await E(voiceA).setPreferences(harden({ speed: 1.25, voice: 'en_x' }));
    const setMs = performance.now() - p0;
    t.deepEqual(await E(voiceB).getPreferences(), {
      speed: 1.25,
      voice: 'en_x',
    });
    for (const speed of [Number.NaN, Infinity, 4.05]) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => E(voiceB).setPreferences(harden({ speed })), {
        message: voiceTexts.preferenceOutOfRange,
      });
    }
    await t.throwsAsync(() =>
      E(voiceB).setPreferences(harden({ voice: 'v'.repeat(129) })),
    );
    await t.throwsAsync(() => E(voiceB).setPreferences(harden({ pitch: 2 })));
    t.deepEqual(await E(voiceA).getPreferences(), {
      speed: 1.25,
      voice: 'en_x',
    });

    // 19: no configureSpeech on Voice; the provisioning step writes them.
    await t.throwsAsync(() =>
      E(voiceA).configureSpeech(
        harden({ speechIn: { kind: 'off' }, speechOut: { kind: 'off' } }),
      ),
    );
    t.is((await E(voiceB).speechSettings()).revision, 0);
    const step = await voiceStep.run({
      client: state.client,
      options: /** @type {any} */ (
        harden({
          voice: {
            speech: {
              speechIn: { kind: 'process', command: ['stt'], language: 'en' },
            },
          },
        })
      ),
    });
    t.false(step.skipped);
    const settings = await E(voiceB).speechSettings();
    t.is(settings.revision, 1);
    t.deepEqual(settings.speechIn.command, ['stt']);

    // 22: the built-in voice preset needs M6's objects.
    const builtIn = await E(voiceA).getVoicePreset();
    const view = await E(builtIn).describe();
    t.like(view, { label: 'voice', builtIn: true, available: false });
    const listed = async () =>
      (await E(slice.factory).listSessions()).rows.length;
    const before = await listed();
    await t.throwsAsync(() => E(voiceA).startVoiceSession(), {
      message: view.unavailableReason,
    });
    t.is(await listed(), before, 'no session for a refused Talk');

    // 8: the shortcut preset, with the catalogue revision.
    const made = await slice.makeBackend(script);
    const talker = await createPreset(a.catalog, {
      label: 'Talker',
      backend: made.backend,
    });
    const { revision } = await E(a.catalog).configuration();
    await t.throwsAsync(() => E(voiceB).setVoicePreset(talker, revision - 1), {
      message: texts.presetStale,
    });
    t.is(await E(voiceA).setVoicePreset(talker, revision), talker);

    // 8, 9, 13: Talk, spoken; again with the same id: the same session.
    const s0 = performance.now();
    const answer = await E(voiceA).startVoiceSession(
      harden({ invocationId: 'launch-1', title: 'talk', at: Date.now() }),
    );
    const startMs = performance.now() - s0;
    t.false(answer.duplicate);
    t.like(await E(answer.session).getInfo(), { presetLabel: 'Talker' });
    const d0 = performance.now();
    const again = await E(voiceB).startVoiceSession(
      harden({ invocationId: 'launch-1' }),
    );
    const duplicateMs = performance.now() - d0;
    t.true(again.duplicate);
    t.is(again.key, answer.key);
    t.is(await listed(), before + 1);
    const spoken = await promptsOf(slice, answer.session, made.log);
    t.true(spoken.length > 0);
    t.is(spoken[0].systemDigest, sha16(composeSystemPrompt({ spoken: true })));

    // A typed session from the same preset, on its own backend's log.
    const typedBackend = await slice.makeBackend(script);
    const typedSession = await E(slice.factory).createSession(
      harden({
        title: 'typed',
        preset: talker,
        backend: typedBackend.backend,
        at: Date.now(),
      }),
    );
    const plain = await promptsOf(slice, typedSession, typedBackend.log);
    t.is(plain[0].systemDigest, sha16(composeSystemPrompt({ spoken: false })));

    emit({
      check: 'voice-session',
      setupMs: round1(ready - t0),
      setPreferencesMs: round1(setMs),
      startVoiceSessionMs: round1(startMs),
      duplicateMs: round1(duplicateMs),
      totalMs: round1(performance.now() - t0),
      by: 'W11.7',
    });
  },
);

const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;

run(
  '14 (G-11): a pinned model missing from its catalogue falls back to the factory default with the warning',
  async t => {
    t.timeout(4 * 60_000);
    const keyDir = path.join(harnessTmp, `voice-g11-${process.pid}`);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    t.teardown(() => rmSync(keyDir, { recursive: true, force: true }));
    const server = await startFakeProviderServer({
      plan: [
        {
          match: { method: 'GET', path: '/api/v1/models' },
          file: 'openrouter-models.json',
          repeat: 20,
        },
      ],
    });
    t.teardown(() => server.close());
    const state = await startFromTemplate(await sliceTemplate(), {
      t,
      secretsKeyFile: path.join(keyDir, 'secrets.key'),
    });
    const slice = await makeSlice(state);
    const secrets = await E(slice.admin).getSecrets();
    const secret = await E(secrets).create(
      harden({ label: 'provider key', description: 'voice G-11 test' }),
    );
    await replaceSealed(
      await E(secrets).openWriter(),
      secret,
      makeTestSecretValue('voice'),
    );
    const pinned = await E(slice.admin).makeBackend(
      harden({
        kind: 'openrouter',
        label: 'OpenRouter',
        keyGrant: await E(secret).makeReadGrant(),
        modelId: 'acme/alpha-a',
        baseUrl: server.openRouterBaseUrl,
      }),
    );
    const fallback = await slice.makeBackend(script);
    await E(slice.harness).configure(
      harden({
        backends: [pinned, fallback.backend],
        defaultBackend: fallback.backend,
        defaultModelId: 'scripted-default',
      }),
    );
    const { operator, catalog } = await operatorOf(slice);
    const voice = await E(operator).getVoice();
    const missing = 'acme/not-in-catalogue';
    const preset = await createPreset(catalog, {
      label: 'Pinned talker',
      backend: pinned,
      modelId: missing,
    });
    await E(voice).setVoicePreset(
      preset,
      (await E(catalog).configuration()).revision,
    );
    const answer = await E(voice).startVoiceSession(
      harden({ title: 'g11', at: Date.now() }),
    );
    t.is(answer.warning, voiceTextOf.voiceModelUnavailable(missing));
    const info = await E(answer.session).getInfo();
    t.is(info.modelId, 'scripted-default');
    t.is(info.presetLabel, 'Pinned talker');
    const contexts = await promptsOf(slice, answer.session, fallback.log);
    t.true(contexts.length > 0, 'the default backend served the turn');
  },
);
