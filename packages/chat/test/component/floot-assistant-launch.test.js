// @ts-check
/* eslint-disable class-methods-use-this -- Minimal Web Audio test double. */
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';
import { flootComponent } from '../../floot-component.js';
import { makeFakeDaemon } from '../helpers/fake-floot.js';
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

const dom = createDOM();
const win = /** @type {Window & typeof globalThis} */ (
  /** @type {unknown} */ (dom.window)
);
const doc = /** @type {Document} */ (/** @type {unknown} */ (dom.document));
globalThis.MutationObserver = win.MutationObserver;
globalThis.requestAnimationFrame = fn => win.setTimeout(() => fn(0), 10);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

/** @import { ExecutionContext } from 'ava' */
/** @param {ExecutionContext} t */
const setup = t => {
  t.timeout(10_000);
  localStorage.clear();
  const native = /** @type {any} */ (win);
  const acknowledgements = [];
  native.AndroidAssistant = {
    postMessage: value => acknowledgements.push(JSON.parse(value)),
  };
  let captures = 0;
  let stops = 0;
  const streams = [];
  const speech = Far('AssistantSpeech', {
    transcribe: reader => {
      const transcript = makeBufferedReader();
      streams.push({ reader, transcript });
      return transcript.reader;
    },
  });
  const oldMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const oldAudio = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  let processor;
  let volume = 0;
  class AudioContext {
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        getFloatTimeDomainData(array) {
          array.fill(volume);
        },
      };
    }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() {}, onaudioprocess: null };
      return processor;
    }
    close() {
      return Promise.resolve();
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: AudioContext,
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        captures += 1;
        return {
          getTracks: () => [
            {
              stop: () => {
                stops += 1;
              },
            },
          ],
        };
      },
    },
  });

  const mounted = [];
  const mount = (daemon = makeFakeDaemon({ count: 1 }), mic = true) => {
    const parent = doc.createElement('div');
    doc.body.append(parent);
    const root = Far('AssistantTestRoot', {
      lookup: name => (name === 'controller' ? daemon.factory : speech),
    });
    const cleanup = flootComponent(
      parent,
      root,
      ['controller'],
      () => {},
      mic ? ['stt'] : [],
    );
    const result = { parent, cleanup, daemon };
    mounted.push(result);
    return result;
  };
  const invoke = id => {
    native.endoAssistantInvocation = { id };
    win.dispatchEvent(new win.Event('endo-assistant'));
  };
  const finish = (index, text) => {
    volume = 0;
    streams[index].transcript.push(harden({ type: 'final', text }));
    streams[index].transcript.push(harden({ type: 'end' }));
  };
  t.teardown(() => {
    for (const { cleanup, parent, daemon } of mounted) {
      cleanup();
      parent.remove();
      for (const turn of daemon.turns)
        turn.channel.push(harden({ type: 'end' }));
    }
    delete native.AndroidAssistant;
    delete native.endoAssistantInvocation;
    if (oldMedia) Object.defineProperty(navigator, 'mediaDevices', oldMedia);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
    if (oldAudio) Object.defineProperty(globalThis, 'AudioContext', oldAudio);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  return {
    mount,
    invoke,
    finish,
    native,
    streams,
    acknowledgements,
    captures: () => captures,
    stops: () => stops,
    setVolume: value => {
      volume = value;
    },
    frame: () => {
      if (!processor) throw Error('Capture did not initialize');
      processor.onaudioprocess({
        inputBuffer: {
          getChannelData: () => new Float32Array(4096).fill(0.03),
        },
      });
    },
  };
};

test.serial(
  'assistant streams audio during provisioning and sends only into its explicit new session',
  async t => {
    const h = setup(t);
    const creation = makePromiseKit();
    const daemon = makeFakeDaemon({ count: 1 });
    let calls = 0;
    daemon.setCreationGate(() => {
      calls += 1;
      return creation.promise;
    });
    h.native.endoAssistantInvocation = { id: 'cold-launch' };
    h.mount(daemon);
    await waitFor(() => h.streams.length === 1 && calls === 1);
    t.is(h.captures(), 1);
    h.frame();
    t.is((await h.streams[0].reader.next()).value.type, 'bytes');
    h.invoke('cold-launch');
    // Recognizer endpointing may finish before our local silence detector.
    h.finish(0, 'hello assistant');
    await tick(950);
    t.is(daemon.turns.length, 0);
    creation.resolve(undefined);
    await waitFor(() => daemon.turns.length === 1);
    t.is(daemon.turns[0].id, 's1');
    t.is(daemon.turns[0].text, 'hello assistant');
    t.is(daemon.created.length, 1);
    t.like(daemon.created[0][0], {
      presetId: 'general',
      backendId: 'fae-codex',
      modelId: 'gpt-5.6-sol',
      spoken: true,
      userInitiated: true,
    });
    t.is(h.acknowledgements.length, 1);
    win.dispatchEvent(new win.Event('endo-suspend'));
    t.is(h.stops(), 1);
  },
);

test.serial(
  'failed assistant creation releases normal microphone submissions',
  async t => {
    const h = setup(t);
    const { parent, daemon } = h.mount();
    await waitFor(() => parent.querySelector('.floot-session-item'));
    daemon.setCreationFailure(true);
    h.invoke('fails');
    await waitFor(() => parent.textContent?.includes('Assistant setup failed'));
    daemon.setCreationFailure(false);
    parent
      .querySelector('.floot-session-item')
      ?.dispatchEvent(new win.Event('click', { bubbles: true }));
    parent
      .querySelector('.floot-mic')
      ?.dispatchEvent(new win.Event('click', { bubbles: true }));
    await tick(1100); // normal microphone noise calibration
    const before = h.streams.length;
    h.setVolume(0.1);
    await waitFor(() => h.streams.length > before);
    h.finish(h.streams.length - 1, 'recovered voice');
    await waitFor(() => daemon.turns.length === 1);
    t.is(daemon.turns[0].id, 's0');
    t.is(daemon.turns[0].text, 'recovered voice');
  },
);

test.serial(
  'detached components cannot claim a reconnect invocation; replay cannot create twice',
  async t => {
    const h = setup(t);
    const old = h.mount();
    await waitFor(() => old.parent.querySelector('.floot-session-item'));
    old.parent.remove(); // reconnect historically leaves the old listener installed
    const current = h.mount();
    h.invoke('after-reconnect');
    await waitFor(() => current.daemon.created.length === 1);
    t.is(old.daemon.created.length, 0);
    current.cleanup();
    current.parent.remove();
    h.native.endoAssistantInvocation = { id: 'after-reconnect' };
    const recreated = h.mount(current.daemon);
    await waitFor(
      () =>
        recreated.parent.querySelectorAll('.floot-session-item').length === 2,
    );
    await tick(100);
    t.is(current.daemon.created.length, 1);
    t.is(h.captures(), 1);
  },
);

test.serial(
  'text-only components leave assistant delivery for a voice-enabled space',
  async t => {
    const h = setup(t);
    h.native.endoAssistantInvocation = { id: 'route-to-voice' };
    const text = h.mount(undefined, false);
    await tick(100);
    t.is(h.acknowledgements.length, 0);
    const voice = h.mount();
    await waitFor(() => voice.daemon.created.length === 1);
    t.is(text.daemon.created.length, 0);
    t.is(h.captures(), 1);
  },
);

test.serial(
  'a superseded provisioning result cannot select its session or submit old speech',
  async t => {
    const h = setup(t);
    const first = makePromiseKit();
    const { daemon, parent } = h.mount();
    let calls = 0;
    daemon.setCreationGate(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve();
    });
    h.invoke('first');
    await waitFor(() => h.streams.length === 1);
    h.finish(0, 'discard this');
    h.invoke('second');
    await waitFor(() => daemon.created.length === 1 && h.streams.length === 2);
    first.resolve(undefined);
    await waitFor(() => daemon.created.length === 2);
    h.finish(1, 'keep this');
    await waitFor(() => daemon.turns.length === 1);
    t.is(
      daemon.turns[0].id,
      's1',
      'second invocation finished provisioning first',
    );
    t.is(daemon.turns[0].text, 'keep this');
    t.truthy(parent.querySelector('.floot-mic.listening'));
  },
);

test.serial(
  'backgrounding during provisioning stops capture and never auto-sends on resume',
  async t => {
    const h = setup(t);
    const creation = makePromiseKit();
    const { daemon } = h.mount();
    daemon.setCreationGate(() => creation.promise);
    h.invoke('background');
    await waitFor(() => h.streams.length === 1);
    h.finish(0, 'do not send');
    win.dispatchEvent(new win.Event('endo-suspend'));
    creation.resolve(undefined);
    await waitFor(() => daemon.created.length === 1);
    win.dispatchEvent(new win.Event('endo-resume'));
    await tick(1000);
    t.is(daemon.turns.length, 0);
    t.is(h.stops(), 1);
    t.is(h.captures(), 1);
  },
);

for (const mode of ['detach', 'suspend']) {
  test.serial(
    `queued invocation survives ${mode} before claim admission`,
    async t => {
      const h = setup(t);
      const old = h.mount();
      await waitFor(() => old.parent.querySelector('.floot-session-item'));
      const held = makePromiseKit();
      const entered = makePromiseKit();
      const lock = navigator.locks.request('floot-assistant-launch', () => {
        entered.resolve(undefined);
        return held.promise;
      });
      await entered.promise;
      h.invoke(`queued-${mode}`);
      let current = old;
      if (mode === 'detach') {
        old.parent.remove();
        current = h.mount();
      } else win.dispatchEvent(new win.Event('endo-suspend'));
      held.resolve(undefined);
      await lock;
      await tick(50);
      if (mode === 'suspend') {
        t.is(old.daemon.created.length, 0);
        win.dispatchEvent(new win.Event('endo-resume'));
        h.invoke(`queued-${mode}`);
      }
      await waitFor(() => current.daemon.created.length === 1);
      if (mode === 'detach') t.is(old.daemon.created.length, 0);
      t.is(h.captures(), 1);
      t.is(h.acknowledgements.length, 1);
    },
  );
}
