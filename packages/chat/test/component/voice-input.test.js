// @ts-nocheck - Component test with happy-dom

import '@endo/init/debug.js';

import test from 'ava';
import { makeVoiceInput } from '@endo/spaces-util/voice-input.js';
import { createDOM, tick } from '../helpers/dom-setup.js';

const {
  window: testWindow,
  document: testDocument,
  cleanup: cleanupDOM,
} = createDOM();

/**
 * Mock SpeechRecognition factory. Each instance records calls to
 * `start` / `stop` and lets the test fire `result`, `end`, and
 * `error` events. Uses an EventTarget-backed approach without class
 * inheritance so SES-frozen primordials do not interfere with the
 * method-dispatch chain.
 */
const makeMockSpeechRecognition = () => {
  /** @type {Array<any>} */
  const instances = [];

  function MockSpeechRecognition() {
    /** @type {Map<string, Set<(event: any) => void>>} */
    const listeners = new Map();
    const self = {
      continuous: false,
      interimResults: false,
      lang: '',
      startCount: 0,
      stopCount: 0,
      startThrows: false,
      stopThrows: false,
      start() {
        if (self.startThrows) {
          throw new Error('already started');
        }
        self.startCount += 1;
      },
      stop() {
        if (self.stopThrows) {
          throw new Error('already stopped');
        }
        self.stopCount += 1;
      },
      addEventListener(type, fn) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener(type, fn) {
        const set = listeners.get(type);
        if (set) set.delete(fn);
      },
      /** @param {string[]} transcripts */
      fireResult(transcripts) {
        const event = {
          results: transcripts.map(transcript => [{ transcript }]),
        };
        const set = listeners.get('result');
        if (set) {
          for (const fn of set) fn(event);
        }
      },
      fireEnd() {
        const set = listeners.get('end');
        if (set) {
          for (const fn of set) fn({});
        }
      },
      /** @param {string} errorName */
      fireError(errorName) {
        const set = listeners.get('error');
        if (set) {
          for (const fn of set) fn({ error: errorName });
        }
      },
    };
    instances.push(self);
    return self;
  }

  return { MockSpeechRecognition, instances };
};

/**
 * Install a constructor under `window.SpeechRecognition`. Returns a
 * teardown function that removes it.
 *
 * @param {any} Constructor
 */
const installSpeechRecognition = Constructor => {
  // happy-dom exposes globalThis.window === window
  testWindow.SpeechRecognition = Constructor;
  return () => {
    delete testWindow.SpeechRecognition;
    delete testWindow.webkitSpeechRecognition;
  };
};

/**
 * Create a container div and a contenteditable input attached to the
 * document body. Returns cleanup that removes both.
 */
const createElements = () => {
  const $container = testDocument.createElement('div');
  $container.id = 'chat-button-wrapper';
  testDocument.body.appendChild($container);

  const $input = testDocument.createElement('div');
  $input.setAttribute('contenteditable', 'true');
  $input.id = 'chat-message';
  testDocument.body.appendChild($input);

  return {
    $container,
    $input,
    cleanup: () => {
      $container.remove();
      $input.remove();
    },
  };
};

test.afterEach(() => {
  testDocument.body.innerHTML = '';
  delete testWindow.SpeechRecognition;
  delete testWindow.webkitSpeechRecognition;
});

test.after(() => {
  cleanupDOM();
});

test.serial('returns null when SpeechRecognition is not available', t => {
  const { $container, $input, cleanup } = createElements();
  // Ensure neither global is present
  delete testWindow.SpeechRecognition;
  delete testWindow.webkitSpeechRecognition;

  const api = makeVoiceInput({ $container, $input });

  t.is(api, null);
  // No mic button should have been appended.
  t.is($container.querySelector('#voice-input-button'), null);
  cleanup();
});

test.serial(
  'falls back to webkitSpeechRecognition when SpeechRecognition is absent',
  t => {
    const { $container, $input, cleanup } = createElements();
    const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
    delete testWindow.SpeechRecognition;
    testWindow.webkitSpeechRecognition = MockSpeechRecognition;

    const api = makeVoiceInput({ $container, $input });

    t.not(api, null);
    t.is(instances.length, 1);
    t.is(
      $container.querySelector('#voice-input-button')?.id,
      'voice-input-button',
    );

    api.destroy();
    delete testWindow.webkitSpeechRecognition;
    cleanup();
  },
);

test.serial('creates a mic button with expected attributes', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });

  const $btn = $container.querySelector('#voice-input-button');
  t.truthy($btn);
  t.is($btn.tagName, 'BUTTON');
  t.is($btn.getAttribute('type'), 'button');
  t.is($btn.getAttribute('aria-label'), 'Voice input');
  t.is($btn.textContent, '\u{1F399}');

  api.destroy();
  teardown();
  cleanup();
});

test.serial('configures recognition with default language en-US', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });

  t.is(instances[0].lang, 'en-US');
  t.is(instances[0].continuous, false);
  t.is(instances[0].interimResults, true);

  api.destroy();
  teardown();
  cleanup();
});

test.serial('honors the lang option when provided', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input, lang: 'fr-FR' });

  t.is(instances[0].lang, 'fr-FR');

  api.destroy();
  teardown();
  cleanup();
});

test.serial('clicking the mic button starts and stops the recognizer', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');

  t.is(instances[0].startCount, 0);
  t.false($btn.classList.contains('listening'));

  $btn.click();
  t.is(instances[0].startCount, 1);
  t.true($btn.classList.contains('listening'));
  t.is($btn.title, 'Listening... (click to stop)');

  $btn.click();
  t.is(instances[0].stopCount, 1);
  t.false($btn.classList.contains('listening'));
  t.is($btn.title, 'Voice input (click to speak)');

  api.destroy();
  teardown();
  cleanup();
});

test.serial('a result event writes the transcript into the input', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');
  $btn.click();

  instances[0].fireResult(['hello world']);
  t.is($input.textContent, 'hello world');

  api.destroy();
  teardown();
  cleanup();
});

test.serial(
  'a result event preserves prior input content as the saved prefix',
  t => {
    const { $container, $input, cleanup } = createElements();
    const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
    const teardown = installSpeechRecognition(MockSpeechRecognition);

    $input.textContent = 'prior ';
    const api = makeVoiceInput({ $container, $input });
    const $btn = $container.querySelector('#voice-input-button');
    $btn.click();

    instances[0].fireResult(['transcribed']);
    t.is($input.textContent, 'prior transcribed');

    api.destroy();
    teardown();
    cleanup();
  },
);

test.serial('a result event concatenates multiple result entries', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');
  $btn.click();

  instances[0].fireResult(['part one ', 'part two']);
  t.is($input.textContent, 'part one part two');

  api.destroy();
  teardown();
  cleanup();
});

test.serial('result events are ignored before listening starts', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });

  // Fire a result without clicking the button first.
  instances[0].fireResult(['stray']);
  t.is($input.textContent, '');

  api.destroy();
  teardown();
  cleanup();
});

test.serial('an empty results array is ignored', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');
  $btn.click();

  instances[0].fireResult([]);
  t.is($input.textContent, '');

  api.destroy();
  teardown();
  cleanup();
});

test.serial(
  'the end event stops listening and dispatches an input event',
  t => {
    const { $container, $input, cleanup } = createElements();
    const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
    const teardown = installSpeechRecognition(MockSpeechRecognition);

    const api = makeVoiceInput({ $container, $input });
    const $btn = $container.querySelector('#voice-input-button');
    $btn.click();
    t.true($btn.classList.contains('listening'));

    let inputEventCount = 0;
    $input.addEventListener('input', () => {
      inputEventCount += 1;
    });

    instances[0].fireEnd();
    t.false($btn.classList.contains('listening'));
    t.is(inputEventCount, 1);

    api.destroy();
    teardown();
    cleanup();
  },
);

test.serial('an error event logs and stops listening', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');
  $btn.click();
  t.true($btn.classList.contains('listening'));

  // console.warn is frozen by SES; verify the side effects we can
  // observe instead (listening stops; the error handler does not
  // throw).
  t.notThrows(() => instances[0].fireError('no-speech'));
  t.false($btn.classList.contains('listening'));

  api.destroy();
  teardown();
  cleanup();
});

test.serial('startListening swallows a recognition.start() that throws', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');

  instances[0].startThrows = true;
  t.notThrows(() => $btn.click());
  // Even though start() threw, the listening UI state still updated.
  t.true($btn.classList.contains('listening'));

  api.destroy();
  teardown();
  cleanup();
});

test.serial('stopListening swallows a recognition.stop() that throws', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');

  $btn.click();
  instances[0].stopThrows = true;
  t.notThrows(() => $btn.click());
  t.false($btn.classList.contains('listening'));

  api.destroy();
  teardown();
  cleanup();
});

test.serial('a second click while not listening becomes a fresh start', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');

  $btn.click();
  instances[0].fireEnd();
  $btn.click();
  t.is(instances[0].startCount, 2);

  api.destroy();
  teardown();
  cleanup();
});

test.serial(
  'startListening refuses to start when the input already holds a chip',
  t => {
    const { $container, $input, cleanup } = createElements();
    const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
    const teardown = installSpeechRecognition(MockSpeechRecognition);

    // Pre-populate the input with a chip element.
    const $chip = testDocument.createElement('span');
    $chip.className = 'chat-token';
    $chip.textContent = '@alice';
    $input.appendChild($chip);

    const api = makeVoiceInput({ $container, $input });
    const $btn = $container.querySelector('#voice-input-button');

    $btn.click();
    t.is(instances[0].startCount, 0);
    t.false($btn.classList.contains('listening'));

    api.destroy();
    teardown();
    cleanup();
  },
);

test.serial('a result that arrives while a chip is present is dropped', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');

  $btn.click();

  // Insert a chip after start; the mutation observer would stop
  // listening, but a queued result can still arrive. Simulate the
  // race by first inserting the chip directly (without giving the
  // observer a chance to run), then firing the result; the result
  // handler's own hasChips() guard should drop it.
  const $chip = testDocument.createElement('span');
  $chip.className = 'chat-token';
  $chip.textContent = '@alice';
  $input.appendChild($chip);

  instances[0].fireResult(['stray transcript']);
  // The chip should survive; the transcript should not have
  // clobbered it.
  t.truthy($input.querySelector('.chat-token'));
  t.false($input.textContent === 'stray transcript');

  api.destroy();
  teardown();
  cleanup();
});

test.serial(
  'a chip inserted mid-session stops listening via the mutation observer',
  async t => {
    const { $container, $input, cleanup } = createElements();
    const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
    const teardown = installSpeechRecognition(MockSpeechRecognition);

    const api = makeVoiceInput({ $container, $input });
    const $btn = $container.querySelector('#voice-input-button');

    $btn.click();
    t.true($btn.classList.contains('listening'));

    const $chip = testDocument.createElement('span');
    $chip.className = 'chat-token';
    $chip.textContent = '@alice';
    $input.appendChild($chip);

    // MutationObserver delivers asynchronously; allow a tick.
    await tick(20);
    t.false($btn.classList.contains('listening'));
    t.true(Number(instances[0].stopCount) >= 1);

    api.destroy();
    teardown();
    cleanup();
  },
);

test.serial('destroy removes the mic button and stops listening', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  const $btn = $container.querySelector('#voice-input-button');
  $btn.click();
  t.true($btn.classList.contains('listening'));

  api.destroy();
  t.is($container.querySelector('#voice-input-button'), null);
  t.is(instances[0].stopCount, 1);

  teardown();
  cleanup();
});

test.serial('destroy is safe to call when not listening', t => {
  const { $container, $input, cleanup } = createElements();
  const { MockSpeechRecognition } = makeMockSpeechRecognition();
  const teardown = installSpeechRecognition(MockSpeechRecognition);

  const api = makeVoiceInput({ $container, $input });
  t.notThrows(() => api.destroy());
  t.is($container.querySelector('#voice-input-button'), null);

  teardown();
  cleanup();
});

test.serial(
  'a redundant stopListening (button click after end) is a no-op',
  t => {
    const { $container, $input, cleanup } = createElements();
    const { MockSpeechRecognition, instances } = makeMockSpeechRecognition();
    const teardown = installSpeechRecognition(MockSpeechRecognition);

    const api = makeVoiceInput({ $container, $input });
    const $btn = $container.querySelector('#voice-input-button');

    $btn.click();
    instances[0].fireEnd();
    // Already stopped via end event. A direct stop attempt should not
    // increment stopCount because the early-return in stopListening
    // guards on isListening.
    const stopCountAfterEnd = instances[0].stopCount;

    // Now click again -> this is a fresh start, not a stop.
    $btn.click();
    t.is(instances[0].startCount, 2);
    t.is(instances[0].stopCount, stopCountAfterEnd);

    api.destroy();
    teardown();
    cleanup();
  },
);
