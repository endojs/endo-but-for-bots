// @ts-check
// The factory vat's `Voice` and `HarnessRoot.configureSpeech`
// (designs/m11-interfaces.md 3.1, 5.1, 14.2; D-M11-9, D-M11-19, D-M11-21,
// D-M11-25), in Node with the real guards, the real preset catalogue and
// the factory kit; the session program is a fake maker.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { createHash } from 'node:crypto';

/* eslint-disable import/no-relative-packages */
import { interfaces, methodNames, texts } from '../../guest/lib/interfaces.js';
import {
  ttsRanges,
  voiceLimits,
  voiceTextOf,
  voiceTexts,
} from '../../guest/lib/voice-preferences.js';
import { makeFactoryKit, stagingSources } from '../../guest/factory/factory.js';
import { makePresetCatalog } from '../../guest/factory/presets.js';
import { makeHarnessRoot, makeProgramStore } from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { makeStartCount } from '../../guest/factory/starts.js';
import { makeVoice, speechSettingsBytes } from '../../guest/factory/voice.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const PROGRAM_SOURCE = '/* fake session program */';

/** The factory kit with a fake session program and its harness root. */
const kitSetup = () => {
  const vats = Far('ThixotropeWorkerController', {
    createWorker: async () =>
      Far('ThixotropeWorkerFacade', {
        /** @param {string} source */
        evaluate: async source =>
          source === stagingSources.evaluate
            ? Far('SpareMaker', {
                make: async () =>
                  harden({
                    session: Far('Session', {}),
                    internal: Far('SessionInternal', {}),
                  }),
              })
            : true,
        retire: async () => undefined,
      }),
  });
  const admin = Far('AgentHostAdmin', {
    forSession: () =>
      Far('SessionHostFacet', { liveChannel: async () => undefined }),
    bindSession: () => undefined,
    onStart: () => Far('Registration', { cancel: () => undefined }),
  });
  const programs = makeProgramStore();
  const digest = createHash('sha256')
    .update(PROGRAM_SOURCE, 'utf8')
    .digest('hex');
  programs.load({ digest, index: 0, count: 1, text: PROGRAM_SOURCE });
  const rows = makeRowTable();
  const kit = makeFactoryKit({
    admin,
    vats,
    programs,
    rows,
    starts: makeStartCount(),
  });
  const root = makeHarnessRoot({
    operator: kit.operator,
    rows,
    programs,
    configureSpeech: kit.configureSpeech,
  });
  return { kit, rows, root };
};

/**
 * A backend built from the real guard whose catalogue knows `models`.
 * @param {string[]} models
 */
const makeBackend = models =>
  makeExo('Backend', interfaces.Backend, {
    describe: () => harden({ kind: 'scripted', label: 'Fake' }),
    open: async () => harden({}),
    listModels: async () => harden({ rows: [], state: 'ok' }),
    /** @param {string} [modelId] */
    resolveModel: async modelId => {
      if (modelId === undefined || !models.includes(modelId))
        throw Error(`Unknown model ${modelId}`);
      return harden({ modelId });
    },
  });

/**
 * `makeVoice` on the real catalogue with a recording `create`.
 * @param {{ fail?: () => Error | undefined, settings?: any }} [options]
 */
const voiceSetup = ({ fail, settings } = {}) => {
  const catalog = makePresetCatalog();
  /** @type {Record<string, any>[]} */
  const created = [];
  /** @type {WeakMap<any, { key: string }>} */
  const keys = new WeakMap();
  /** @type {Array<(value?: any) => void>} */
  const gates = [];
  let gated = false;
  /** @param {Record<string, any>} options */
  const create = async options => {
    const error = fail?.();
    if (error !== undefined) throw error;
    if (gated) await new Promise(resolve => gates.push(resolve));
    created.push(options);
    const session = Far('Session', {});
    keys.set(session, { key: `s${created.length}` });
    return session;
  };
  const rows = /** @type {any} */ ({ ofSession: s => keys.get(s) });
  const starts = makeStartCount();
  const voice = makeVoice({ catalog, create, rows, settings, starts });
  return {
    catalog,
    created,
    starts,
    voice,
    facet: voice.facet,
    gate: () => {
      gated = true;
    },
    release: () => {
      gated = false;
      for (const open of gates.splice(0)) open();
    },
  };
};

/**
 * A user preset (template `general`, no object: available).
 * @param {any} catalog
 * @param {Record<string, any>} [extra]
 */
const userPreset = async (catalog, extra = {}) => {
  const { revision } = catalog.facet.configuration();
  const { preset } = await E(catalog.facet).create(
    harden({ label: 'Talker', template: 'general', ...extra }),
    revision,
  );
  return preset;
};

test('Operator.getVoice answers one Voice; it has no configureSpeech (D-M11-21)', async t => {
  const { kit } = kitSetup();
  const voice = await E(kit.operator).getVoice();
  t.is(await E(kit.operator).getVoice(), voice);
  t.deepEqual([...methodNames.Voice].sort(), [
    'getPreferences',
    'getVoicePreset',
    'setPreferences',
    'setVoicePreset',
    'speechSettings',
    'startVoiceSession',
  ]);
  t.false(methodNames.Voice.includes('configureSpeech'));
  t.is(/** @type {any} */ (voice).configureSpeech, undefined);
  await t.throwsAsync(() =>
    E(/** @type {any} */ (voice)).configureSpeech(
      harden({ speechIn: { kind: 'off' }, speechOut: { kind: 'off' } }),
    ),
  );
  t.like(await E(voice).speechSettings(), { revision: 0 });
});

test('preferences merge; out-of-range, non-finite, long and unknown fields are refused and change nothing', async t => {
  const { facet } = voiceSetup();
  t.deepEqual(await E(facet).getPreferences(), {});
  t.deepEqual(
    await E(facet).setPreferences(harden({ voice: 'en_GB-other-low' })),
    { voice: 'en_GB-other-low' },
  );
  t.deepEqual(await E(facet).setPreferences(harden({ speed: 1.5 })), {
    voice: 'en_GB-other-low',
    speed: 1.5,
  });
  for (const speed of [NaN, Infinity, ttsRanges.speed.max + 0.05, 0.2]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(facet).setPreferences(harden({ speed })), {
      message: voiceTexts.preferenceOutOfRange,
    });
  }
  await t.throwsAsync(
    () => E(facet).setPreferences(harden({ noiseW: 1, sentenceSilence: 6 })),
    { message: voiceTexts.preferenceOutOfRange },
  );
  await t.throwsAsync(() =>
    E(facet).setPreferences(
      harden({ voice: 'v'.repeat(voiceLimits.voiceUnits + 1) }),
    ),
  );
  await t.throwsAsync(() =>
    E(facet).setPreferences(/** @type {any} */ (harden({ pitch: 1 }))),
  );
  t.deepEqual(await E(facet).getPreferences(), {
    voice: 'en_GB-other-low',
    speed: 1.5,
  });
});

test('the shortcut preset: the built-in voice by default; a stale revision, a foreign or deleted preset are refused', async t => {
  const { catalog, facet } = voiceSetup();
  const builtIn = catalog.builtIn('voice');
  t.is(await E(facet).getVoicePreset(), builtIn);
  const preset = await userPreset(catalog);
  const { revision } = catalog.facet.configuration();
  await t.throwsAsync(() => E(facet).setVoicePreset(preset, revision - 1), {
    message: texts.presetStale,
  });
  const foreign = makePresetCatalog().builtIn('general');
  await t.throwsAsync(() => E(facet).setVoicePreset(foreign, revision), {
    message: voiceTexts.presetNotUsable,
  });
  t.is(await E(facet).setVoicePreset(preset, revision), preset);
  t.is(await E(facet).getVoicePreset(), preset);
  // Deleted: the shortcut falls back to the built-in; choosing it again is refused.
  const after = await E(preset).delete(revision);
  t.is(await E(facet).getVoicePreset(), builtIn);
  await t.throwsAsync(() => E(facet).setVoicePreset(preset, after), {
    message: voiceTexts.presetNotUsable,
  });
});

test('Talk on the built-in voice preset needs its objects (D-M11-25); a chosen user preset creates a spoken session', async t => {
  const { kit, rows } = kitSetup();
  const voice = await E(kit.operator).getVoice();
  const builtIn = kit.catalog.builtIn('voice');
  const view = await E(builtIn).describe();
  t.false(view.available);
  await t.throwsAsync(() => E(voice).startVoiceSession(), {
    message: view.unavailableReason,
  });
  t.is(rows.size(), 0, 'no row for the refused launch');
  const preset = await userPreset(kit.catalog, { backend: makeBackend([]) });
  await E(voice).setVoicePreset(
    preset,
    kit.catalog.facet.configuration().revision,
  );
  const answer = await E(voice).startVoiceSession(
    harden({ title: 'spoken', at: 1000 }),
  );
  t.false(answer.duplicate);
  t.is(answer.warning, undefined);
  t.is(rows.ofSession(answer.session)?.key, answer.key);
  t.is(rows.size(), 1);
});

test('each pinned API shortcut launch reads the backend and model once', async t => {
  const { kit } = kitSetup();
  const voice = await E(kit.operator).getVoice();
  let descriptions = 0;
  let lookups = 0;
  const backend = Far('Backend', {
    describe() {
      descriptions += 1;
      return harden({ kind: 'openrouter', label: 'API' });
    },
    resolveModel() {
      lookups += 1;
      return harden({ modelId: 'pinned' });
    },
  });
  const preset = await userPreset(kit.catalog, { backend, modelId: 'pinned' });
  await E(voice).setVoicePreset(
    preset,
    kit.catalog.facet.configuration().revision,
  );
  await E(voice).startVoiceSession();
  await E(voice).startVoiceSession();
  t.is(descriptions, 2);
  t.is(lookups, 2);
});

test('a shortcut whose preset changes during preflight describes the newly selected backend', async t => {
  const { kit, rows } = kitSetup();
  const voice = await E(kit.operator).getVoice();
  const { makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);
  const started = makePromiseKit();
  const gate = makePromiseKit();
  const old = Far('Backend', {
    describe() {
      throw Error('Old backend unavailable');
    },
    async resolveModel() {
      started.resolve(undefined);
      await gate.promise;
      return harden({ modelId: 'previous' });
    },
  });
  const preset = await userPreset(kit.catalog, {
    backend: old,
    modelId: 'previous',
  });
  await E(voice).setVoicePreset(
    preset,
    kit.catalog.facet.configuration().revision,
  );
  const creation = E(voice).startVoiceSession();
  await started.promise;
  await E(preset).save(
    harden({
      label: 'Talker',
      template: 'general',
      backend: makeBackend(['current']),
      modelId: 'current',
    }),
    kit.catalog.facet.configuration().revision,
  );
  gate.resolve(undefined);
  const { session } = await creation;
  t.is(rows.ofSession(session)?.modelId, 'current');
});

test('the creation options: the shortcut preset, title and at passed through; no spoken flag (M11 9.1)', async t => {
  const { catalog, created, facet } = voiceSetup();
  const preset = await userPreset(catalog);
  await E(facet).setVoicePreset(preset, catalog.facet.configuration().revision);
  await E(facet).startVoiceSession(harden({ title: 'x', at: 7 }));
  t.deepEqual(created, [{ preset, title: 'x', at: 7 }]);
});

test('G-11: a pinned model its backend refuses falls back to the factory default with a warning (D-M11-9)', async t => {
  const pinned = makeBackend(['known']);
  const fallback = makeBackend(['default-model']);
  const settings = harden({
    defaultBackend: () => fallback,
    defaultModelId: () => 'default-model',
  });
  const { catalog, created, facet } = voiceSetup({
    settings: /** @type {any} */ (settings),
  });
  const missing = await userPreset(catalog, {
    backend: pinned,
    modelId: 'gone',
  });
  await E(facet).setVoicePreset(
    missing,
    catalog.facet.configuration().revision,
  );
  const answer = await E(facet).startVoiceSession();
  t.is(answer.warning, voiceTextOf.voiceModelUnavailable('gone'));
  t.deepEqual(created[0], {
    preset: missing,
    backend: fallback,
    modelId: 'default-model',
  });
  const { revision } = catalog.facet.configuration();
  await E(missing).save(
    harden({
      label: 'Talker',
      template: 'general',
      backend: pinned,
      modelId: 'known',
    }),
    revision,
  );
  const kept = await E(facet).startVoiceSession();
  t.is(kept.warning, undefined);
  t.deepEqual(created[1], { preset: missing });
});

test('launch claims: a duplicate answers the same session; 33 ids forget the first; a launch in progress; a restart re-runs (R6-60)', async t => {
  const { catalog, created, facet, gate, release, starts } = voiceSetup();
  const preset = await userPreset(catalog);
  await E(facet).setVoicePreset(preset, catalog.facet.configuration().revision);
  const first = await E(facet).startVoiceSession(
    harden({ invocationId: 'id-0' }),
  );
  const again = await E(facet).startVoiceSession(
    harden({ invocationId: 'id-0' }),
  );
  t.true(again.duplicate);
  t.is(again.session, first.session);
  t.is(again.key, first.key);
  t.is(created.length, 1);
  for (let i = 1; i <= voiceLimits.invocationClaims; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(facet).startVoiceSession(harden({ invocationId: `id-${i}` }));
  }
  t.is(created.length, 33);
  // id-1 is still claimed; id-0 was forgotten (the oldest of 33).
  t.true(
    (await E(facet).startVoiceSession(harden({ invocationId: 'id-1' })))
      .duplicate,
  );
  const fresh = await E(facet).startVoiceSession(
    harden({ invocationId: 'id-0' }),
  );
  t.false(fresh.duplicate);
  t.not(fresh.session, first.session);
  t.is(created.length, 34);

  // A launch whose creation is running: the same id is refused in this
  // start, re-run after a restart (an older start count).
  gate();
  const pending = E(facet).startVoiceSession(harden({ invocationId: 'slow' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  await t.throwsAsync(
    () => E(facet).startVoiceSession(harden({ invocationId: 'slow' })),
    { message: voiceTexts.launchInProgress },
  );
  starts.next();
  const rerun = E(facet).startVoiceSession(harden({ invocationId: 'slow' }));
  release();
  const [old, made] = await Promise.all([pending, rerun]);
  t.false(made.duplicate);
  t.not(old.session, made.session, 'at most one extra session (O-8)');
  const claimed = await E(facet).startVoiceSession(
    harden({ invocationId: 'slow' }),
  );
  t.true(claimed.duplicate);
  t.is(claimed.session, made.session, 'the re-run holds the claim');
});

test('a failed creation drops its claim; the error propagates', async t => {
  let failing = true;
  const { catalog, created, facet } = voiceSetup({
    fail: () => (failing ? Error('no spare') : undefined),
  });
  const preset = await userPreset(catalog);
  await E(facet).setVoicePreset(preset, catalog.facet.configuration().revision);
  await t.throwsAsync(
    () => E(facet).startVoiceSession(harden({ invocationId: 'x' })),
    { message: 'no spare' },
  );
  failing = false;
  const answer = await E(facet).startVoiceSession(
    harden({ invocationId: 'x' }),
  );
  t.false(answer.duplicate);
  t.is(created.length, 1);
  await t.throwsAsync(() =>
    E(facet).startVoiceSession(
      harden({ invocationId: 'i'.repeat(voiceLimits.invocationIdUnits + 1) }),
    ),
  );
});

/**
 * Process speech-in settings whose command arguments hold `units` units in
 * all (split into arguments of at most `commandArgUnits`).
 * @param {number} units
 */
const processSettings = units => {
  /** @type {string[]} */
  const command = [];
  for (let left = units; left > 0; left -= voiceLimits.commandArgUnits)
    command.push('a'.repeat(Math.min(left, voiceLimits.commandArgUnits)));
  return harden({
    speechIn: { kind: 'process', command, language: 'en' },
    speechOut: { kind: 'off' },
  });
};

/** Units of `processSettings(0)` outside the command. */
const FIXED_UNITS = 'process'.length + 'en'.length + 'off'.length;

test('HarnessRoot.configureSpeech: kept with the next revision and read by Voice.speechSettings (19)', async t => {
  const { kit, root } = kitSetup();
  const voice = await E(kit.operator).getVoice();
  const grant = makeExo('ReadGrant', interfaces.ReadGrant, {
    describe: () => harden({ label: 'speech key', description: '' }),
  });
  const settings = harden({
    speechIn: {
      kind: 'openai-audio',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'whisper-1',
      language: 'en',
      key: grant,
      partialIntervalMs: 1500,
    },
    speechOut: {
      kind: 'process',
      command: ['piper'],
      voicesDir: 'voices',
      defaultVoice: 'en_US-test-medium',
      defaultSpeed: 1,
      spareSynth: true,
    },
    revision: 41,
  });
  const written = await E(root).configureSpeech(settings);
  t.is(written.revision, 1, 'the factory numbers its settings');
  t.is(written.speechIn.key, grant);
  t.deepEqual(await E(voice).speechSettings(), written);
  t.is((await E(root).configureSpeech(processSettings(8))).revision, 2);
});

test('configureSpeech refusals: 33 arguments, a 4,097-unit argument, the estimate over one frame, an empty command, a speed out of range', async t => {
  const { kit, root } = kitSetup();
  const voice = await E(kit.operator).getVoice();
  t.is(speechSettingsBytes, 22_528);
  await t.throwsAsync(() =>
    E(root).configureSpeech(
      harden({
        speechIn: {
          kind: 'process',
          command: Array.from(
            { length: voiceLimits.commandArgs + 1 },
            () => 'a',
          ),
          language: 'en',
        },
        speechOut: { kind: 'off' },
      }),
    ),
  );
  await t.throwsAsync(() =>
    E(root).configureSpeech(
      harden({
        speechIn: {
          kind: 'process',
          command: ['a'.repeat(voiceLimits.commandArgUnits + 1)],
          language: 'en',
        },
        speechOut: { kind: 'off' },
      }),
    ),
  );
  // Estimate units x 3: 7,510 units is 22,530 bytes (the first multiple of
  // three over 22,528); 7,509 units is 22,527 and is kept.
  const overUnits = Math.floor(speechSettingsBytes / 3) + 1;
  await t.throwsAsync(
    () => E(root).configureSpeech(processSettings(overUnits - FIXED_UNITS)),
    { message: voiceTexts.speechSettingsInvalid },
  );
  t.is((await E(voice).speechSettings()).revision, 0, 'nothing kept');
  const fits = await E(root).configureSpeech(
    processSettings(overUnits - 1 - FIXED_UNITS),
  );
  t.is(fits.revision, 1);
  await t.throwsAsync(
    () =>
      E(root).configureSpeech(
        harden({
          speechIn: { kind: 'process', command: [], language: 'en' },
          speechOut: { kind: 'off' },
        }),
      ),
    { message: voiceTexts.speechSettingsInvalid },
  );
  await t.throwsAsync(
    () =>
      E(root).configureSpeech(
        harden({
          speechIn: { kind: 'off' },
          speechOut: {
            kind: 'process',
            command: ['piper'],
            voicesDir: 'v',
            defaultSpeed: 5,
          },
        }),
      ),
    { message: voiceTexts.speechSettingsInvalid },
  );
  await t.throwsAsync(() =>
    E(root).configureSpeech(
      /** @type {any} */ (
        harden({ speechIn: { kind: 'wasm' }, speechOut: { kind: 'off' } })
      ),
    ),
  );
  t.is((await E(voice).speechSettings()).revision, 1);
});

test('a root made without the voice kit refuses configureSpeech', async t => {
  const { kit, rows } = kitSetup();
  const root = makeHarnessRoot({
    operator: kit.operator,
    rows,
    programs: makeProgramStore(),
  });
  await t.throwsAsync(
    () =>
      E(root).configureSpeech(
        harden({ speechIn: { kind: 'off' }, speechOut: { kind: 'off' } }),
      ),
    { message: voiceTexts.speechNotWired },
  );
});
