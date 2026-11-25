// @ts-check
// The voice feature (designs/m11-interfaces.md section 9; D-M11-13,
// D-M11-17, D-M11-20; R5-22, R5-45..R5-50, R5-53, R5-55, R6-60, P-66):
// settings resolution, the controller's submission notice (H10),
// auto-speak of this page's sends only (started and queued), dictation
// from capture blocks to the grace send, mic off, barge-in, the debounced
// preference write and playback restart, Talk, the launch link, Replay,
// the shortcut preset and the wake lock, then the slot components. The
// `Speech`, `AudioPort` and `Voice` fakes are exos on the real guards
// (speech-guards.js, guards/factory.js appendix A); the rest of the page is
// M3's controller over its fake powers.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/prepare-endo.js';

import { E, Far } from '@endo/far';
import { h, render } from 'preact';

/* eslint-disable import/no-relative-packages */
import { interfaces } from '../../guest/lib/interfaces.js';
import { speechInterfaces } from '../../guest/lib/speech-guards.js';
import { ttsDefaults, voiceLimits } from '../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */
import { speechTexts } from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { TurnView } from '../../ui/src/conversation/MessageList.js';
import { makeController } from '../../ui/src/controller/index.js';
import { endpointingDefaults } from '../../ui/src/voice/endpointing-defaults.js';
import { feature } from '../../ui/src/voice/feature.js';
import {
  REPLAY_INLINE_UNITS,
  VOICE_CACHE_KEY,
  WAITING_KEPT,
  audioUrlOf,
  launchIdOf,
  replayPiecesOf,
  resolveVoiceSettings,
  textPieces,
  voiceStateOf,
} from '../../ui/src/voice/state.js';
import { voiceUiTexts } from '../../ui/src/voice/texts.js';
import {
  VoiceControls,
  VoiceModeSwitch,
} from '../../ui/src/voice/VoiceControls.js';
import { VoicePanel } from '../../ui/src/voice/VoicePanel.js';
import { makeFakePowers, makeTestDom } from './_m3-fake-powers.js';
import { runEffectsPromptly } from './_m4-ui-fakes.js';

const { makeExo } = /** @type {any} */ (globalThis);

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** A `localStorage` stand-in. */
const makeStorage = () => {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    map,
    /** @param {string} key */
    getItem: key => map.get(key) ?? null,
    /** @param {string} key @param {string} value */
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    /** @param {string} key */
    removeItem: key => {
      map.delete(key);
    },
    /** @param {number} index */
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
};

/** Web Locks that run each callback in turn. */
const locks = {
  /**
   * @param {string} _name
   * @param {() => Promise<any>} callback
   */
  request: (_name, callback) => callback(),
};

// A token-shaped test value, built at run time.
const TOKEN = ['5a', '6b'].join('').repeat(16);
const RANGE = (/** @type {number} */ min, /** @type {number} */ max) =>
  harden({ min, max, step: 0.05 });

const configuration = harden({
  speechIn: true,
  speechOut: true,
  voices: [
    { id: 'en_US-test-medium', name: 'English (US) test', sampleRate: 22_050 },
    { id: 'en_GB-other-low', name: 'English (GB) other', sampleRate: 16_000 },
  ],
  defaults: {
    voice: 'en_US-test-medium',
    speed: 1,
    noiseScale: 0.5,
    noiseW: 0.8,
    sentenceSilence: 0.3,
  },
  ranges: {
    speed: RANGE(0.25, 4),
    noiseScale: RANGE(0, 2),
    noiseW: RANGE(0, 2),
    sentenceSilence: RANGE(0, 5),
  },
});

/**
 * `Speech` and `AudioPort` on the real guards (speech-guards.js).
 *
 * @param {{ calls: any[][] }} log
 * @param {boolean} [enabled]
 */
const makeFakeSpeech = (log, enabled = true) => {
  let utterances = 0;
  let playbacks = 0;
  const port = makeExo('AudioPort', speechInterfaces.AudioPort, {
    async transcribe() {
      log.calls.push(['transcribe']);
      utterances += 1;
      return harden({ stream: utterances * 2 - 1 });
    },
    /**
     * @param {any} session
     * @param {string} turnId
     * @param {any} [options]
     */
    async speak(session, turnId, options) {
      log.calls.push(['speak', session, turnId, options]);
      playbacks += 1;
      return harden({ stream: playbacks * 2 });
    },
    close() {
      log.calls.push(['close']);
    },
  });
  const speech = makeExo('Speech', speechInterfaces.Speech, {
    openAudio() {
      log.calls.push(['openAudio']);
      return harden({ port, token: TOKEN });
    },
    async configuration() {
      return harden({
        ...configuration,
        speechIn: enabled,
        speechOut: enabled,
      });
    },
    status() {
      return harden({
        speechIn: 'ready',
        speechOut: 'ready',
        ports: 1,
        streams: 0,
      });
    },
    /**
     * @param {any} audioPort
     * @param {any[]} pieces
     * @param {any} [options]
     */
    async replay(audioPort, pieces, options) {
      log.calls.push(['replay', audioPort, pieces, options]);
      playbacks += 1;
      return harden({ stream: playbacks * 2 });
    },
  });
  return { speech, port };
};

/**
 * The factory's `Voice` on the real guard (appendix A), over a fake
 * preset catalogue and the fake powers' sessions.
 *
 * @param {{ calls: any[][], prefs: any, presets: any[], chosen?: any, revision: number, addSession: (key: string) => any, warning?: string }} state
 */
const makeFakeVoice = state =>
  makeExo('Voice', interfaces.Voice, {
    getPreferences() {
      state.calls.push(['getPreferences']);
      return state.prefs;
    },
    /** @param {any} patch */
    setPreferences(patch) {
      state.calls.push(['setPreferences', patch]);
      state.prefs = harden({ ...state.prefs, ...patch });
      return state.prefs;
    },
    getVoicePreset() {
      return state.chosen ?? state.presets[0];
    },
    /**
     * @param {any} preset
     * @param {number} revision
     */
    setVoicePreset(preset, revision) {
      state.calls.push(['setVoicePreset', preset, revision]);
      if (revision !== state.revision) throw Error('stale revision');
      state.chosen = preset;
      state.revision += 1;
      return preset;
    },
    /** @param {any} [request] */
    async startVoiceSession(request = {}) {
      state.calls.push(['startVoiceSession', request]);
      const key = `v${state.calls.length}`;
      const session = state.addSession(key);
      return harden({
        session,
        key,
        duplicate: false,
        ...(state.warning ? { warning: state.warning } : {}),
      });
    },
    speechSettings() {
      return harden({
        speechIn: { kind: 'off' },
        speechOut: { kind: 'off' },
        revision: 0,
      });
    },
  });

/**
 * The page's io: a fake clock and timers, a fake audio socket, capture,
 * player and wake lock.
 *
 * @param {{ hash?: string, failCapture?: boolean }} [options]
 */
const makeFakeIo = ({ hash = '', failCapture = false } = {}) => {
  let clock = 1_000_000;
  /** @type {Array<{ at: number, fn: () => void, id: number }>} */
  let timers = [];
  let nextTimer = 0;
  /** @type {any[]} */
  const sockets = [];
  /** @type {any[]} */
  const captures = [];
  /** @type {boolean[]} */
  const wake = [];
  const player = {
    unlocks: 0,
    gesture: () => {},
    stops: 0,
    audible: false,
    playing: false,
    /** @type {(playing: boolean) => void} */
    onChange: () => {},
  };
  const storage = makeStorage();
  const io = {
    now: () => clock,
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimer: (fn, ms) => {
      nextTimer += 1;
      timers.push({ at: clock + ms, fn, id: nextTimer });
      return nextTimer;
    },
    /** @param {number} id */
    clearTimer: id => {
      timers = timers.filter(timer => timer.id !== id);
    },
    storage: () => storage,
    location: () => ({
      hash: `#gateway=127.0.0.1:8920&agent=fake${hash}`,
      search: '',
    }),
    /** @param {{ url: string, token: string, onClose: () => void }} options */
    openSocket: ({ url, token, onClose }) => {
      let closed = false;
      const socket = {
        url,
        token,
        onClose,
        /** @type {any[]} */
        utterances: [],
        /** @type {any[]} */
        playbacks: [],
        ready: Promise.resolve(
          harden({
            speechIn: true,
            speechOut: true,
            sampleRate: 16_000,
            audioFrameBytes: 65_536,
          }),
        ),
        /**
         * @param {Promise<number>} streamOf
         * @param {any} handlers
         */
        utterance(streamOf, handlers) {
          Promise.resolve(streamOf).catch(() => {});
          const u = {
            handlers,
            /** @type {Uint8Array[]} */
            sent: [],
            ended: false,
            /** @type {string | undefined} */
            aborted: undefined,
            /** @param {Uint8Array} pcm */
            send(pcm) {
              u.sent.push(pcm);
            },
            end() {
              u.ended = true;
            },
            abort(reason = speechTexts.stopped) {
              u.aborted = reason;
              handlers.onEvent?.({ type: 'abort', reason });
            },
          };
          socket.utterances.push(u);
          return u;
        },
        /**
         * @param {Promise<number>} streamOf
         * @param {any} handlers
         */
        playback(streamOf, handlers) {
          const p = {
            handlers,
            stopped: false,
            stream: Promise.resolve(streamOf),
            stop() {
              p.stopped = true;
              handlers.onEvent?.({
                type: 'abort',
                reason: speechTexts.stopped,
              });
            },
          };
          p.stream.catch(() => {});
          socket.playbacks.push(p);
          return p;
        },
        bufferedBytes: () => 0,
        closed: () => closed,
        close() {
          closed = true;
        },
      };
      sockets.push(socket);
      return socket;
    },
    /** @param {{ onBlock: (pcm: Uint8Array, rms: number) => void }} options */
    openCapture: ({ onBlock }) => {
      const capture = {
        onBlock,
        stopped: false,
        started: failCapture
          ? Promise.reject(Object.assign(Error('denied'), { reason: 'denied' }))
          : Promise.resolve(),
        stop() {
          capture.stopped = true;
        },
      };
      capture.started.catch(() => {});
      captures.push(capture);
      return capture;
    },
    watchActivation: (/** @type {() => void} */ gesture) => {
      player.gesture = gesture;
    },
    /** @param {(playing: boolean) => void} onChange */
    makePlayer: onChange => {
      player.onChange = onChange;
      return {
        unlock: async () => {
          player.unlocks += 1;
        },
        begin: () => ({ pcm: () => {}, current: () => true }),
        stop: () => {
          player.stops += 1;
        },
        audible: () => player.audible,
        playing: () => player.playing,
      };
    },
    wakeLock: {
      /** @param {boolean} wanted */
      set: wanted => {
        wake.push(wanted);
      },
      refresh: () => {},
    },
  };
  /** @param {number} ms */
  const advance = ms => {
    const until = clock + ms;
    for (;;) {
      const due = timers
        .filter(timer => timer.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(timer => timer !== due);
      clock = Math.max(clock, due.at);
      due.fn();
    }
    clock = until;
  };
  /**
   * Feed capture blocks of one level for `ms` (85 ms each).
   *
   * @param {number} rms
   * @param {number} ms
   */
  const blocks = (rms, ms) => {
    const capture = captures[captures.length - 1];
    for (let elapsed = 0; elapsed < ms; elapsed += 85) {
      advance(85);
      capture.onBlock(new Uint8Array([rms > 0.05 ? 1 : 0, 0]), rms);
    }
  };
  return { io, sockets, captures, wake, player, storage, advance, blocks };
};

/**
 * A page: the controller over fake powers with `Voice` and `Speech`, and
 * its voice state.
 *
 * @param {object} [options]
 * @param {any} [options.prefs]
 * @param {string} [options.hash]
 * @param {boolean} [options.failCapture]
 * @param {any[]} [options.sessions]
 * @param {any[]} [options.script]
 * @param {string} [options.warning]
 * @param {boolean} [options.enabled]
 * @param {boolean} [options.withSpeech]
 */
const setup = async ({
  prefs = harden({}),
  hash,
  failCapture,
  sessions = [{ key: 's1' }],
  script,
  warning,
  enabled = true,
  withSpeech = true,
} = {}) => {
  const log = { calls: /** @type {any[][]} */ ([]) };
  const { speech, port } = makeFakeSpeech(log, enabled);
  const presets = [
    Far('Preset', {
      describe: async () => ({
        label: 'voice',
        builtIn: true,
        available: true,
      }),
    }),
    Far('Preset', {
      describe: async () => ({
        label: 'tools',
        builtIn: false,
        available: false,
        unavailableReason: 'needs a runner',
      }),
    }),
    Far('Preset', {
      describe: async () => ({ label: 'mine', builtIn: false }),
    }),
  ];
  /** @type {any} */
  let fakeRef;
  const voiceState = {
    calls: log.calls,
    prefs,
    presets,
    chosen: undefined,
    revision: 7,
    warning,
    /** @param {string} key */
    addSession: key => fakeRef.control.addSession({ key }),
  };
  const voice = makeFakeVoice(voiceState);
  const catalog = Far('PresetCatalog', {
    configuration: () =>
      harden({
        revision: voiceState.revision,
        presets,
        defaultPreset: presets[0],
      }),
  });
  const fake = makeFakePowers({
    sessions,
    script,
    operatorMethods: { getVoice: () => voice, getPresets: () => catalog },
    extras: withSpeech ? [{ label: 'speech', service: speech }] : [],
  });
  fakeRef = fake;
  const storage = makeStorage();
  let id = 0;
  const controller = makeController({
    storage,
    locks,
    now: () => 1_800_000_000_000,
    makeRequestId: () => {
      id += 1;
      return `req${id}`;
    },
  });
  await controller.attach(fake.powers);
  await flush();
  const page = makeFakeIo({ hash, failCapture });
  const voiceOf = () =>
    voiceStateOf(
      controller.featureContext(),
      () => /** @type {any} */ (page.io),
    );
  const state = voiceOf();
  await flush();
  return {
    ...fake,
    ...page,
    log,
    port,
    speech,
    voiceState,
    presets,
    controller,
    state,
    voiceOf,
  };
};

/** @param {any[][]} calls @param {string} name */
const callsNamed = (calls, name) => calls.filter(call => call[0] === name);

test('settings resolve field by field: server, device cache, service defaults, built-in', t => {
  t.deepEqual(resolveVoiceSettings(), { ...ttsDefaults });
  const settings = resolveVoiceSettings(
    { speed: 1.5, noiseScale: Number.NaN, voice: '' },
    { speed: 2, noiseW: 0.5, noiseScale: 9 },
    configuration.defaults,
  );
  t.deepEqual(settings, {
    voice: 'en_US-test-medium',
    speed: 1.5,
    noiseScale: 0.5,
    noiseW: 0.5,
    sentenceSilence: 0.3,
  });
  t.is(
    resolveVoiceSettings({ voice: 'x'.repeat(voiceLimits.voiceUnits + 1) })
      .voice,
    ttsDefaults.voice,
  );
});

test('launch id, audio URL and replay pieces', async t => {
  t.is(launchIdOf({ hash: '#gateway=a&agent=b&voice=inv-1' }), 'inv-1');
  t.is(launchIdOf({ hash: '#gateway=a&agent=b' }), undefined);
  t.is(launchIdOf({ hash: `#voice=${'i'.repeat(129)}` }), undefined);
  t.is(
    audioUrlOf({ hash: '#gateway=127.0.0.1:8920&agent=x', search: '' }),
    'ws://127.0.0.1:8920/audio',
  );
  t.is(audioUrlOf({ hash: '', search: '' }), undefined);
  const tab = makeStorage();
  const linked = { hash: '#gateway=localhost:8920&agent=fake' };
  t.is(audioUrlOf(linked, tab), 'ws://localhost:8920/audio');
  t.is(audioUrlOf({ hash: '' }, tab), 'ws://localhost:8920/audio');
  t.is(audioUrlOf({ search: '?agent=fake' }, tab), undefined);

  const words = 'word '.repeat(4000);
  const cut = textPieces(words);
  t.true(cut.every(piece => piece.length <= 8192));
  t.is(cut.join(''), words);
  t.true(cut[0].endsWith(' '), 'cut at white space');

  const blob = Far('Blob', {});
  const sealed = { sealed: Far('SealedText', {}), preview: 'old' };
  const pieces = await replayPiecesOf(
    [
      { role: 'user', text: 'not spoken' },
      { role: 'assistant', text: 'First reply.' },
      { role: 'tool', name: 'x', args: '', result: 'no' },
      { role: 'assistant', text: { preview: 'long', blob, bytes: 9000 } },
      { role: 'assistant', text: sealed },
    ],
    async staged => (staged === sealed ? 'Archived reply.' : ''),
  );
  t.deepEqual(pieces, ['First reply.\n', blob, 'Archived reply.\n']);

  const many = await replayPiecesOf(
    Array.from({ length: 100 }, () => ({
      role: 'assistant',
      text: 'y'.repeat(8000),
    })),
    async () => '',
  );
  t.true(many.length <= 64);
  const units = many.reduce(
    (/** @type {number} */ sum, /** @type {any} */ piece) =>
      sum + String(piece).length,
    0,
  );
  t.true(units <= REPLAY_INLINE_UNITS);
});

test('the controller tells submission listeners each answered send, and forgets them on attach (H10)', async t => {
  const { controller, powers } = await setup({ withSpeech: false });
  await controller.selectSession('s1');
  /** @type {any[]} */
  const notices = [];
  controller.onSubmission(notice => notices.push(notice));
  await controller.send('hello');
  t.is(notices.length, 1);
  t.is(notices[0].sessionKey, 's1');
  t.is(notices[0].requestId, 'req1');
  t.is(notices[0].receipt.state, 'started');
  t.false(notices[0].spoken, 'a typed send');
  await controller.attach(powers);
  await flush();
  await controller.send('again');
  t.is(notices.length, 1, 'cleared on attach');
});

test('the features show only on a connection that serves speech', async t => {
  t.deepEqual(
    feature.map(item => [item.id, item.slot]),
    [
      ['voice.controls', 'composer.addon'],
      ['voice.mode', 'composer.action'],
      ['voice.panel', 'app.panel'],
      ['voice.replay', 'message.action'],
    ],
  );
  const without = await setup({ withSpeech: false });
  t.false(Boolean(feature[0].when?.(without.controller.featureContext())));
  t.false(without.state.view().available);
  const withSpeech = await setup();
  t.true(Boolean(feature[1].when?.(withSpeech.controller.featureContext())));
  t.true(withSpeech.state.view().available);
});

test('the connection reads configuration and preferences; settings follow R5-55 and are cached', async t => {
  const { state, storage, log } = await setup({
    prefs: harden({ speed: 1.5 }),
  });
  t.is(callsNamed(log.calls, 'getPreferences').length, 1);
  const view = state.view();
  t.true(view.speechIn);
  t.true(view.speechOut);
  t.true(view.autoSpeak, 'auto-speak is on whenever speech out is wired');
  t.is(view.settings.speed, 1.5);
  t.is(view.settings.sentenceSilence, 0.3);
  t.deepEqual(
    JSON.parse(/** @type {string} */ (storage.getItem(VOICE_CACHE_KEY))),
    view.settings,
  );
});

test("auto-speak: a started send of this page is spoken with the settings; another page's turn is not", async t => {
  const { controller, state, log, sockets, control, powers } = await setup();
  const session = control.session;
  await controller.selectSession('s1');
  await controller.send('hello', { spoken: true });
  await flush();
  const speaks = callsNamed(log.calls, 'speak');
  t.is(speaks.length, 1);
  t.is(speaks[0][1], session('s1'));
  t.is(speaks[0][2], controller.getState().view?.current?.turnId);
  t.is(speaks[0][3].voice, 'en_US-test-medium');
  t.is(speaks[0][3].speed, 1);
  t.is(sockets.length, 1);
  t.is(sockets[0].token, TOKEN);
  t.is(sockets[0].url, 'ws://127.0.0.1:8920/audio');
  t.true(state.view().autoSpeak);

  // A typed send (no spoken marker) is not spoken (9.1).
  control.play('s1');
  await flush();
  await controller.send('typed');
  await flush();
  t.is(callsNamed(log.calls, 'speak').length, 1);

  // A turn this page did not send (another page's submit) is not spoken.
  await E(powers.composer).submit(session('s1'), 'from elsewhere', 'other1');
  await flush();
  t.is(callsNamed(log.calls, 'speak').length, 1);

  // Muted: nothing more is spoken, and the playback stops.
  state.setAutoSpeak(false);
  t.false(state.view().autoSpeak);
  t.true(sockets[0].playbacks[0].stopped);
});

test('a typed interaction unlocks autoplay and the settings toggle unlocks it after mute', async t => {
  const { state, player } = await setup();
  player.gesture();
  t.is(player.unlocks, 1);
  state.setAutoSpeak(false);
  player.gesture();
  t.is(player.unlocks, 1);
  state.setAutoSpeak(true);
  t.is(player.unlocks, 2);
});

test('auto-speak: a queued send is spoken when its turn starts, after one receipt read', async t => {
  const { controller, log, control } = await setup({
    sessions: [{ key: 's1', running: 'earlier' }],
  });
  await controller.selectSession('s1');
  await flush();
  await controller.send('queued one', { spoken: true });
  await flush();
  t.is(callsNamed(log.calls, 'speak').length, 0);
  t.is(control.callsOf('Session', 'getSubmissionReceipt').length, 0);
  control.play('s1');
  await flush();
  t.is(control.callsOf('Session', 'getSubmissionReceipt').length, 1);
  const speaks = callsNamed(log.calls, 'speak');
  t.is(speaks.length, 1);
  t.is(speaks[0][2], controller.getState().view?.current?.turnId);
});

test('a muted page reads no receipt and no turn status for its sends (no extra crank)', async t => {
  const { controller, state, log, control } = await setup({
    sessions: [{ key: 's1', running: 'earlier' }],
  });
  await controller.selectSession('s1');
  state.setAutoSpeak(false);
  t.false(state.view().autoSpeak);
  await controller.send('queued while muted', { spoken: true });
  control.play('s1');
  await flush();
  control.play('s1');
  await controller.send('started while muted', { spoken: true });
  await flush();
  t.is(control.callsOf('Session', 'getSubmissionReceipt').length, 0);
  t.is(control.callsOf('Turn', 'getStatus').length, 0);
  t.is(callsNamed(log.calls, 'speak').length, 0);
});

test('waiting submissions are bounded', async t => {
  const { controller, control } = await setup({
    sessions: [{ key: 's1', running: 'earlier' }],
  });
  await controller.selectSession('s1');
  for (let i = 0; i < WAITING_KEPT + 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await controller.send(`queued ${i}`, { spoken: true });
  }
  await flush();
  control.play('s1');
  await flush();
  t.is(control.callsOf('Session', 'getSubmissionReceipt').length, WAITING_KEPT);
});

test('dictation: calibration, onset with pre-roll, partials replace, final then grace sends the box (R5-22)', async t => {
  const {
    controller,
    state,
    log,
    sockets,
    captures,
    blocks,
    advance,
    control,
  } = await setup();
  await controller.selectSession('s1');
  state.toggleMode();
  await flush();
  t.true(state.view().micOn);
  t.is(captures.length, 1);
  t.is(callsNamed(log.calls, 'openAudio').length, 1);

  blocks(0.001, endpointingDefaults.calibrationMs + 200);
  t.is(sockets[0].utterances.length, 0);
  blocks(0.2, 600);
  const [utterance] = sockets[0].utterances;
  t.truthy(utterance);
  await flush();
  t.is(callsNamed(log.calls, 'transcribe').length, 1);
  t.true(Number(utterance.sent.length) > 1, 'pre-roll and the onset block');

  utterance.handlers.onEvent({ type: 'partial', text: 'hel' });
  t.is(controller.getState().view?.input.text, 'hel');
  utterance.handlers.onEvent({ type: 'partial', text: 'hello wor' });
  t.is(controller.getState().view?.input.text, 'hello wor');

  blocks(0.001, endpointingDefaults.trailingSilenceMs + 100);
  t.true(utterance.ended);
  utterance.handlers.onEvent({ type: 'final', text: 'hello world' });
  t.is(controller.getState().view?.input.text, 'hello world');
  t.is(control.callsOf('Composer', 'submit').length, 0);
  advance(endpointingDefaults.graceMs);
  await flush();
  const submits = control.callsOf('Composer', 'submit');
  t.is(submits.length, 1);
  t.is(submits[0][3], 'hello world');
  t.deepEqual(submits[0][5], { spoken: true }, 'the spoken marker (9.1)');
  t.is(controller.getState().view?.input.text, '');
});

test('dictation: a short burst is discarded; an edited box is sent as edited; clearing it cancels', async t => {
  const { controller, state, sockets, blocks, advance, control } =
    await setup();
  await controller.selectSession('s1');
  state.toggleMode();
  await flush();
  blocks(0.001, 1200);
  blocks(0.2, 170);
  blocks(0.001, 1300);
  const [burst] = sockets[0].utterances;
  t.is(burst.aborted, speechTexts.stopped, 'discarded: ABORT');

  blocks(0.2, 600);
  blocks(0.001, 1300);
  const second = sockets[0].utterances[1];
  second.handlers.onEvent({ type: 'final', text: 'buy milk' });
  controller.setInput('buy oat milk');
  advance(endpointingDefaults.graceMs);
  await flush();
  t.is(control.callsOf('Composer', 'submit')[0][3], 'buy oat milk');

  blocks(0.2, 600);
  blocks(0.001, 1300);
  const third = sockets[0].utterances[2];
  third.handlers.onEvent({ type: 'final', text: 'never mind' });
  controller.setInput('');
  advance(endpointingDefaults.graceMs);
  await flush();
  t.is(control.callsOf('Composer', 'submit').length, 1, 'cleared: cancelled');
});

test('mic off discards the unsent dictation and its box; a failed capture says so', async t => {
  const { controller, state, sockets, captures, blocks, advance, control } =
    await setup();
  await controller.selectSession('s1');
  state.toggleMode();
  await flush();
  blocks(0.001, 1200);
  blocks(0.2, 600);
  blocks(0.001, 1300);
  const [utterance] = sockets[0].utterances;
  utterance.handlers.onEvent({ type: 'final', text: 'send this' });
  state.toggleMode();
  t.false(state.view().micOn);
  t.true(captures[0].stopped);
  t.is(controller.getState().view?.input.text, '');
  advance(5000);
  await flush();
  t.is(control.callsOf('Composer', 'submit').length, 0);

  const failing = await setup({ failCapture: true });
  await failing.controller.selectSession('s1');
  failing.state.toggleMode();
  await flush();
  t.false(failing.state.view().micOn);
  t.is(failing.state.view().note, voiceUiTexts.captureFailure.denied);
});

test('barge-in during a busy turn stops playback and shows continuing in background (R5-46)', async t => {
  const { controller, state, sockets, blocks, player, control } = await setup();
  await controller.selectSession('s1');
  await controller.send('tell me a story', { spoken: true });
  await flush();
  t.is(sockets[0].playbacks.length, 1);
  player.audible = true;
  state.toggleMode();
  await flush();
  blocks(0.001, 1200);
  const stopsBefore = player.stops;
  blocks(0.3, 300);
  t.true(sockets[0].playbacks[0].stopped, 'synthesis stream aborted');
  t.true(player.stops > stopsBefore, 'audio stopped');
  t.true(state.view().bargeIn);
  control.play('s1');
  await flush();
  t.false(state.view().bargeIn, 'cleared when the turn ends');
});

test('a preference change is used at once, written once after the debounce, and restarts the playback (R5-50)', async t => {
  const { controller, state, log, sockets, advance, storage } = await setup();
  await controller.selectSession('s1');
  await controller.send('hello', { spoken: true });
  await flush();
  state.setPreference('speed', 2);
  state.setPreference('noiseW', 1);
  state.setPreference('speed', Number.NaN);
  t.is(state.view().settings.speed, 2);
  t.is(
    JSON.parse(/** @type {string} */ (storage.getItem(VOICE_CACHE_KEY))).noiseW,
    1,
  );
  t.is(callsNamed(log.calls, 'setPreferences').length, 0);
  advance(voiceLimits.settingsDebounceMs - 1);
  t.is(callsNamed(log.calls, 'setPreferences').length, 0);
  advance(1);
  await flush();
  const writes = callsNamed(log.calls, 'setPreferences');
  t.deepEqual(writes, [['setPreferences', { speed: 2, noiseW: 1 }]]);
  const speaks = callsNamed(log.calls, 'speak');
  t.is(speaks.length, 2, 'restarted');
  t.is(speaks[1][3].speed, 2);
  t.true(sockets[0].playbacks[0].stopped);
});

test('Talk starts a spoken session from the shortcut, selects it, shows the warning and opens the mic', async t => {
  const { controller, state, log, captures } = await setup({
    warning: 'The voice preset model is not available',
  });
  state.talk();
  t.is(captures.length, 1, 'mic opened inside the tap');
  await flush(20);
  const [start] = callsNamed(log.calls, 'startVoiceSession');
  t.truthy(start);
  t.is(controller.getState().activeKey, `v${log.calls.indexOf(start) + 1}`);
  t.is(state.view().note, 'The voice preset model is not available');
  t.true(state.view().micOn);
  t.true(state.view().spoken, 'the new session view is in spoken mode');
  t.false(state.view().talking);
});

test('a spoken send that failed keeps the marker in its draft and resends with it (9.1, M3 K3/K4)', async t => {
  const { controller, control, powers } = await setup();
  await controller.selectSession('s1');
  control.failNext('Composer', 'submit', Error('link down'));
  await controller.send('said once', { spoken: true });
  // The draft (the controller's storage) is resent on the next attach.
  await controller.attach(powers);
  await flush();
  const submits = control.callsOf('Composer', 'submit');
  t.is(submits.length, 2);
  t.is(submits[1][3], 'said once');
  t.is(submits[1][4], submits[0][4], 'the same request id');
  t.deepEqual(submits[1][5], { spoken: true });
});

test('spoken mode belongs to one session view; typed sends in it carry no marker (9.1)', async t => {
  const { controller, state, captures, control } = await setup({
    sessions: [{ key: 's1' }, { key: 's2' }],
  });
  await controller.selectSession('s1');
  t.false(state.view().spoken);
  state.toggleMode();
  t.true(state.view().spoken);
  t.is(captures.length, 1, 'mic opened inside the tap');
  // A message typed and sent with Send in spoken mode is a typed message.
  await controller.send('typed in spoken mode');
  const [typed] = control.callsOf('Composer', 'submit');
  t.is(typed.length, 5, 'no options argument');
  await controller.selectSession('s2');
  await flush();
  t.false(state.view().spoken, 'leaving the view ends spoken mode');
  t.true(captures[0].stopped);
  state.toggleMode();
  t.true(state.view().spoken);
  state.toggleMode();
  t.false(state.view().spoken);
  t.false(state.view().micOn);

  const off = await setup({ enabled: false });
  await off.controller.selectSession('s1');
  off.state.toggleMode();
  t.false(off.state.view().spoken, 'needs speech in and out');
  t.is(off.captures.length, 0);
});

test('a launch link starts its session once, records in invocation mode, and not again after a reconnect', async t => {
  const { controller, state, log, captures, powers, blocks, sockets } =
    await setup({ hash: '&voice=inv-7' });
  await flush(20);
  const starts = callsNamed(log.calls, 'startVoiceSession');
  t.is(starts.length, 1);
  t.is(starts[0][1].invocationId, 'inv-7');
  t.true(state.view().micOn);
  t.is(captures.length, 1);
  blocks(0.2, 85);
  t.is(sockets[0].utterances.length, 1, 'no calibration: opens at once');
  t.truthy(controller.getState().activeKey);

  await controller.attach(powers);
  await flush(20);
  t.is(callsNamed(log.calls, 'startVoiceSession').length, 1);
});

test.serial(
  'each assistant bubble plays only its own text, including a staged message',
  async t => {
    runEffectsPromptly();
    const dom = makeTestDom();
    try {
      const { controller, log } = await setup();
      const blob = Far('Blob', {});
      const context = controller.featureContext();
      const entry = {
        turnId: 't1',
        state: 'running',
        record: { input: 'user input' },
        fold: {
          messages: [
            { role: 'assistant', text: 'a' },
            { role: 'tool', name: 'example', args: '{}' },
            {
              role: 'assistant',
              text: { preview: 'preview', bytes: 9000, blob },
            },
            { role: 'assistant', text: '   ' },
          ],
          streamingText: 'still streaming',
        },
      };
      render(
        h(TurnView, {
          entry,
          view: {},
          features: feature,
          controller,
          context,
        }),
        dom.root,
      );
      const buttons = [
        ...dom.document.querySelectorAll('button[aria-label="Play message"]'),
      ];
      t.is(buttons.length, 2);
      const bubbles = buttons.map(button => {
        t.is(button.closest('.floot-msg'), null);
        const actions = button.closest('.thix-message-actions');
        t.true(
          actions.parentElement.matches(
            '.floot-msg-row.assistant.thix-assistant-message',
          ),
        );
        const bubble = actions.previousElementSibling;
        t.true(bubble.matches('.floot-msg'));
        return bubble;
      });
      t.is(bubbles[0].textContent, 'a');
      t.true(bubbles[1].textContent.includes('preview'));
      t.false(
        Boolean(
          dom.document.querySelector(
            '.streaming button, .user button.thix-voice-replay',
          ),
        ),
      );
      buttons[1].click();
      await flush();
      buttons[0].click();
      await flush();
      const replays = callsNamed(log.calls, 'replay');
      t.deepEqual(
        replays.map(call => call[2]),
        [[blob], ['a\n']],
      );
      render(null, dom.root);
    } finally {
      await dom.close();
    }
  },
);

test('only automatic speech suppresses a reply that settled before live playback opened', async t => {
  const { controller, state, sockets } = await setup();
  await controller.selectSession('s1');
  await controller.send('hello', { spoken: true });
  await flush();
  const abort = { type: 'abort', reason: speechTexts.turnNotLive };
  sockets[0].playbacks[0].handlers.onEvent(abort);
  t.is(state.view().note, '');
  await state.replay({ role: 'assistant', text: 'finished' });
  sockets[0].playbacks[1].handlers.onEvent(abort);
  t.is(state.view().note, voiceUiTexts.playbackUnavailable);
  sockets[0].playbacks[1].handlers.onEvent({
    type: 'abort',
    reason: 'Audio unavailable',
  });
  t.is(state.view().note, 'Audio unavailable');
});

test('a rejected playback open suppresses the automatic race and reports a manual failure', async t => {
  const { controller, state, sockets } = await setup();
  await controller.selectSession('s1');
  await state.replay({ role: 'assistant', text: 'ready' });
  sockets[0].playback = () => {
    throw Error(speechTexts.turnNotLive);
  };
  await controller.send('hello', { spoken: true });
  await flush();
  t.is(state.view().note, '');
  await state.replay({ role: 'assistant', text: 'a' });
  t.is(state.view().note, voiceUiTexts.playbackUnavailable);
});

test('the shortcut preset is chosen by object with the catalogue revision; a stale one is refused and re-read', async t => {
  const { state, log, presets, voiceState } = await setup();
  state.panelOpened();
  await flush();
  const { shortcut } = state.view();
  t.is(shortcut.state, 'ready');
  t.deepEqual(
    shortcut.entries.map(entry => [entry.label, entry.available]),
    [
      ['voice', true],
      ['tools', false],
      ['mine', true],
    ],
  );
  t.is(shortcut.selected, 0);
  await state.chooseShortcut(2);
  t.deepEqual(callsNamed(log.calls, 'setVoicePreset')[0].slice(1), [
    presets[2],
    7,
  ]);
  t.is(state.view().shortcut.selected, 2);
  t.is(state.view().shortcut.revision, 8);
  // Another device changed the catalogue: the revision read is stale.
  voiceState.revision += 1;
  await state.chooseShortcut(0);
  t.is(state.view().note, 'stale revision');
  t.is(state.view().shortcut.selected, 2, 'unchanged');
  t.is(state.view().shortcut.revision, 9, 'read again');
});

test('the wake lock is wanted while the mic is on or the turn runs, and released after (P-66)', async t => {
  const { controller, state, wake, control } = await setup();
  await controller.selectSession('s1');
  state.toggleMode();
  t.true(wake[wake.length - 1]);
  state.toggleMode();
  t.false(wake[wake.length - 1]);
  await controller.send('hello');
  await flush();
  t.true(wake[wake.length - 1], 'busy turn');
  control.play('s1');
  await flush();
  t.false(wake[wake.length - 1]);
});

test('a new connection drops the old port and listener; the page state stays', async t => {
  const { controller, state, powers, sockets, voiceOf, log } = await setup();
  await controller.selectSession('s1');
  state.toggleMode();
  await flush();
  t.is(sockets.length, 1);
  await controller.attach(powers);
  await flush();
  t.is(voiceOf(), state, 'one state per page');
  t.true(sockets[0].closed());
  t.true(state.view().micOn, 'the mic stays on');
  await controller.selectSession('s1');
  await controller.send('after reconnect', { spoken: true });
  await flush();
  t.is(callsNamed(log.calls, 'speak').length, 1, 'the new listener speaks');
  t.is(callsNamed(log.calls, 'openAudio').length, 2);
});

test.serial('the controls and the panel render the state', async t => {
  runEffectsPromptly();
  const dom = makeTestDom();
  try {
    const { controller, state, captures } = await setup();
    const context = controller.featureContext();
    await controller.selectSession('s1');
    render(
      h('div', null, [
        h(VoiceControls, { context }),
        h(VoiceModeSwitch, { context }),
      ]),
      dom.root,
    );
    await flush();
    t.is(dom.document.querySelectorAll('.thix-voice-meter').length, 0);
    const buttons = [...dom.document.querySelectorAll('button')];
    t.is(buttons.length, 1, 'one mode switch, no pills');
    const [button] = buttons;
    t.is(button.getAttribute('aria-label'), voiceUiTexts.spokenMode);
    t.is(button.getAttribute('aria-pressed'), 'false');
    t.is(button.title, voiceUiTexts.toSpokenMode);
    t.truthy(button.querySelector('svg'));
    t.is(button.textContent, '');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await flush();
    t.is(captures.length, 1);
    const pressed = dom.document.querySelector('.thix-voice-mode');
    t.is(pressed.getAttribute('aria-pressed'), 'true');
    t.is(pressed.title, voiceUiTexts.toTextMode);
    t.is(
      dom.document.querySelectorAll('.thix-voice-meter').length,
      1,
      'the meter shows while listening',
    );
    state.toggleMode();
    await flush();
    t.is(dom.document.querySelectorAll('.thix-voice-meter').length, 0);

    render(h(VoicePanel, { context }), dom.root);
    await flush();
    const voices = [
      ...dom.document.querySelectorAll('.thix-voice-voice option'),
    ].map(option => option.value);
    t.deepEqual(voices, ['en_US-test-medium', 'en_GB-other-low']);
    t.is(dom.document.querySelectorAll('input[type=range]').length, 4);
    const presetOptions = [
      ...dom.document.querySelectorAll('.thix-voice-shortcut option'),
    ].map(option => [option.textContent, option.disabled]);
    t.deepEqual(presetOptions, [
      ['voice', false],
      ['tools', true],
      ['mine', false],
    ]);
    t.is(
      dom.document.querySelector('.thix-voice-talk').textContent,
      voiceUiTexts.talk,
      'Talk is in the Voice panel',
    );
    render(null, dom.root);
  } finally {
    await dom.close();
  }
});

test.serial(
  'unconfigured speech explains the disabled mode switch in the composer',
  async t => {
    runEffectsPromptly();
    const dom = makeTestDom();
    try {
      const { controller } = await setup({ enabled: false });
      const context = controller.featureContext();
      render(
        h('div', null, [
          h(VoiceControls, { context }),
          h(VoiceModeSwitch, { context }),
        ]),
        dom.root,
      );
      t.true(dom.document.querySelector('.thix-voice-mode').disabled);
      t.true(dom.root.textContent.includes(voiceUiTexts.speechInOff));
      t.true(dom.root.textContent.includes(voiceUiTexts.speechOutOff));
      render(h(VoicePanel, { context }), dom.root);
      t.true(dom.document.querySelector('.thix-voice-autospeak').disabled);
      render(null, dom.root);
    } finally {
      await dom.close();
    }
  },
);
