// @ts-check
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { makeBufferedReader } from '@endo/exo-stream/buffered-channel.js';

import { flootComponent } from '../../floot-component.js';
import { makeFakeDaemon } from '../helpers/fake-floot.js';
import { createDOM, tick, waitFor } from '../helpers/dom-setup.js';

/** @import { ExecutionContext } from 'ava' */

const dom = createDOM();
const win = /** @type {Window & typeof globalThis} */ (
  /** @type {unknown} */ (dom.window)
);
const doc = /** @type {Document} */ (/** @type {unknown} */ (dom.document));
globalThis.MutationObserver = win.MutationObserver;
globalThis.requestAnimationFrame = fn => win.setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
test.beforeEach(() => localStorage.clear());

/** @param {ExecutionContext} t @param {object} [options] @param {boolean} [options.tts] */
const setup = async (t, { tts = false } = {}) => {
  t.timeout(5000);
  const parent = doc.createElement('div');
  doc.body.append(parent);
  let speechCalls = 0;
  const daemon = makeFakeDaemon({
    count: 1,
    onSpeak: () => {
      speechCalls += 1;
      const audio = makeBufferedReader();
      audio.push(harden({ type: 'end' }));
      return audio.reader;
    },
  });
  const speech = Far('Speech', {});
  const root = Far('AudioTestRoot', {
    lookup: name => (name === 'controller' ? daemon.factory : speech),
  });
  const cleanup = flootComponent(
    parent,
    root,
    ['controller'],
    () => {},
    ['stt'],
    tts ? ['tts'] : [],
  );
  t.teardown(() => {
    cleanup();
    for (const turn of daemon.turns) turn.channel.push(harden({ type: 'end' }));
    parent.remove();
  });
  await waitFor(
    () => parent.querySelectorAll('.floot-session-item').length === 1,
  );
  await tick(30);
  return { parent, cleanup, daemon, speechCalls: () => speechCalls };
};

for (const mode of ['suspend', 'unmount']) {
  test.serial(
    `a microphone grant arriving after ${mode} releases every track`,
    async t => {
      const { parent, cleanup } = await setup(t);
      const grant = makePromiseKit();
      let requests = 0;
      let stops = 0;
      const old = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => {
            requests += 1;
            return grant.promise;
          },
        },
      });
      t.teardown(() => {
        if (old) Object.defineProperty(navigator, 'mediaDevices', old);
        else Reflect.deleteProperty(navigator, 'mediaDevices');
      });
      parent
        .querySelector('.floot-mic')
        ?.dispatchEvent(new win.Event('click', { bubbles: true }));
      await waitFor(() => requests === 1);
      if (mode === 'suspend') win.dispatchEvent(new win.Event('endo-suspend'));
      else cleanup();
      grant.resolve({
        getTracks: () => [
          {
            stop: () => {
              stops += 1;
            },
          },
        ],
      });
      await waitFor(() => stops === 1);
      t.is(stops, 1);
      t.falsy(parent.querySelector('.floot-mic.listening'));
      if (mode === 'suspend') {
        parent
          .querySelector('.floot-mic')
          ?.dispatchEvent(new win.Event('click', { bubbles: true }));
        await tick();
        t.is(
          requests,
          1,
          'background clicks cannot start another permission request',
        );
      }
    },
  );
}

test.serial(
  'a turn observed after suspension stays silent; explicit resume permits future speech',
  async t => {
    const old = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    class SilentAudioContext {
      state = 'running';
      currentTime = 0;
      suspend() {
        this.state = 'suspended';
        return Promise.resolve();
      }
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      close() {
        this.state = 'closed';
        return Promise.resolve();
      }
    }
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: SilentAudioContext,
    });
    t.teardown(() => {
      if (old) Object.defineProperty(globalThis, 'AudioContext', old);
      else Reflect.deleteProperty(globalThis, 'AudioContext');
    });
    const { parent, daemon, speechCalls } = await setup(t, { tts: true });
    const send = text => {
      const input = /** @type {HTMLTextAreaElement} */ (
        parent.querySelector('.floot-input')
      );
      input.value = text;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    };
    send('before background');
    win.dispatchEvent(new win.Event('endo-suspend'));
    await waitFor(() => daemon.turns.length === 1);
    await tick(100);
    t.is(
      speechCalls(),
      0,
      'late own-turn observation does not start synthesis',
    );
    daemon.turns[0].channel.push(harden({ type: 'end' }));
    await tick(100);
    win.dispatchEvent(new win.Event('endo-resume'));
    send('after foreground');
    await waitFor(() => speechCalls() === 1);
    t.is(daemon.turns.length, 2);
  },
);
