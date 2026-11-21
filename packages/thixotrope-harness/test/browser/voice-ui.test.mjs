// @ts-check

/**
 * Voice in the browser (designs/m11-interfaces.md 13; W11.9), in headless
 * Chromium through `startBrowserGateway`, against the real daemon with the
 * speech extension and the fake process engines. The microphone is a
 * synthetic stream: `getUserMedia` is replaced before the page's scripts
 * by an oscillator whose level the test sets (`thixVoiceTest.setLevel`),
 * so the real capture worklet, endpointer, audio socket, player and wake
 * lock code run; `navigator.wakeLock` is a recording stub.
 *
 *  6. The mic calibrates on silence, a burst of tone opens an utterance,
 *     partials replace the compose box's text, 1,200 ms of silence ends it,
 *     and after the 800 ms grace the box's final text is sent (the
 *     transcript shows it).
 * 11. The level meter moves with the input.
 * 12. Auto-speak: the turn of page A's send is spoken on page A; page B,
 *     watching the same session, speaks nothing (one playback's sentences
 *     at the fake TTS).
 *  7. Barge-in (the page half): speaking while the reply plays and its turn
 *     runs shows "continuing in background…", stops the playback (its fake
 *     TTS process ends), the turn completes, and the new utterance's
 *     message is sent behind it.
 * 18. The wake lock is requested while the mic is on and released after
 *     the mic is off and the turn and speech are over.
 *
 * Gated by THIX_HARNESS_BROWSER=1 and a Chromium (`_harness.mjs`):
 *
 *   corepack yarn test:browser test/browser/voice-ui.test.mjs
 */
import '../unit/_m1a-prelude.js';

import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import test from '@endo/ses-ava/test.js';
import { E } from '@endo/far';

import { tmpRoot } from '../template/index.js';
import {
  makeSlice,
  sliceTemplate,
  waitFor,
} from '../integration/_m1a-slice.js';
import {
  engineFiles,
  engineLog,
  fakeEngineSpeech,
} from '../integration/_voice-speech.js';
import { browserEnabled, startBrowserGateway } from './_harness.mjs';

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** The reply's sentences, streamed over about 4.5 s. */
const REPLY = Array.from({ length: 30 }, (_, i) => `Reply sentence ${i}.`);
const replayPrompt = 'Check message playback';
const replayParts = [
  'Opening playback check.',
  'Closing playback check with enough words to wrap this assistant message across multiple lines on a narrow phone screen.',
];
const replyScript = harden({
  turns: [
    {
      input: replayPrompt,
      rounds: [
        {
          chunks: [{ text: replayParts[0] }],
          toolCalls: [{ name: 'echo', args: JSON.stringify({ text: 'ack' }) }],
        },
        { chunks: [{ text: replayParts[1] }] },
      ],
    },
    {
      rounds: [
        {
          chunks: REPLY.map(text => ({ text: `${text} ` })),
          chunkDelayMs: 150,
          usage,
        },
      ],
    },
  ],
});

/**
 * Runs in every page before its own scripts (and before its lockdown): a
 * synthetic microphone and a recording wake lock.
 */
const voiceStubs = () => {
  const g = /** @type {any} */ (globalThis);
  const probe = {
    level: 0,
    /** @type {any} */
    gain: undefined,
    /** @type {[number, string][]} */
    wake: [],
    gumCalls: 0,
    /** @param {number} level peak amplitude 0..1 */
    setLevel: level => {
      probe.level = level;
      if (probe.gain) probe.gain.gain.value = level;
    },
  };
  g.thixVoiceTest = probe;
  const getUserMedia = async () => {
    probe.gumCalls += 1;
    const context = new g.AudioContext({ sampleRate: 48_000 });
    await context.resume();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 220;
    const gain = context.createGain();
    gain.gain.value = probe.level;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    probe.gain = gain;
    return destination.stream;
  };
  if (g.navigator.mediaDevices) {
    Object.defineProperty(g.navigator.mediaDevices, 'getUserMedia', {
      value: getUserMedia,
      configurable: true,
    });
  }
  const wakeLock = {
    request: async (/** @type {string} */ type) => {
      probe.wake.push([Date.now(), `request ${type}`]);
      return {
        released: false,
        release: async () => {
          probe.wake.push([Date.now(), 'release']);
        },
        addEventListener: () => {},
      };
    },
  };
  Object.defineProperty(g.navigator, 'wakeLock', {
    value: wakeLock,
    configurable: true,
  });
};

(browserEnabled ? test.serial : test.skip)(
  '6, 11, 12, 7, 18: dictation to the grace send, the meter, auto-speak on the sending page only, barge-in, the wake lock',
  async t => {
    t.timeout(4 * 60_000);
    const engines = path.join(tmpRoot, `voice-ui-${process.pid}`);
    t.teardown(() => rmSync(engines, { recursive: true, force: true }));
    const speech = fakeEngineSpeech(engines);
    const files = engineFiles(engines);
    const gw = await startBrowserGateway({
      template: await sliceTemplate(),
      provision: async ({ root }) => {
        await E(root).configureSpeech(speech);
      },
      initScript: voiceStubs,
    });
    t.teardown(() => gw.close());
    const { page, state } = gw;
    /** @type {string[]} */
    const pageLog = [];
    page.on('pageerror', (/** @type {any} */ e) =>
      pageLog.push(`pageerror: ${e.message}`),
    );
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(replyScript);
    await E(slice.harness).configure(harden({ backends: [made.backend] }));
    const session = await E(slice.factory).createSession(
      harden({
        title: 'voice',
        preset: slice.chatOnly,
        backend: made.backend,
        userInitiated: true,
        at: Date.now(),
      }),
    );
    const { key } = await E(session).getInfo();
    /** @param {any} p */
    const openSession = async p => {
      await p.locator(`.floot-session-item[data-key="${key}"]`).click();
      await p.locator('.thix-voice-mic').waitFor({ timeout: 30_000 });
    };
    await openSession(page);
    // Page B watches the same session.
    const pageB = await gw.newPage();
    await openSession(pageB);

    // The mic: calibration on silence, then a burst of tone.
    const mic = page.locator('.thix-voice-mic');
    t.is((await mic.textContent())?.trim(), 'Start listening');
    await mic.click();
    await waitFor(
      () => page.evaluate(() => globalThis.thixVoiceTest.gumCalls > 0),
      10_000,
      'the capture asked for the mic',
    );
    await page.waitForTimeout(1500);
    const meter = page.locator('.thix-voice-meter');
    const quiet = Number(await meter.getAttribute('aria-valuenow'));
    await page.evaluate(() => globalThis.thixVoiceTest.setLevel(0.3));
    const box = page.locator('textarea.floot-input');
    // 11: the meter moves; 6: partials replace the box's text.
    await waitFor(
      async () => {
        const now = await meter.getAttribute('aria-valuenow');
        return Number(now) > 0.05;
      },
      10_000,
      'the meter moved',
    );
    const loud = Number(await meter.getAttribute('aria-valuenow'));
    t.true(loud > quiet, `the meter moves (${quiet} -> ${loud})`);
    const partial = await waitFor(
      async () => {
        const value = await box.inputValue();
        return /\d+ bytes/.test(value) ? value : undefined;
      },
      15_000,
      'a partial in the compose box',
    );
    t.regex(partial, /^\d+ bytes$/, 'a partial is the whole text so far');
    await page.waitForTimeout(1200);
    await page.evaluate(() => globalThis.thixVoiceTest.setLevel(0));
    // 1,200 ms of silence, the final, then the 800 ms grace send.
    const finalText = await waitFor(
      async () => {
        const value = await box.inputValue();
        return /^final \d+$/.test(value.trim()) ? value.trim() : undefined;
      },
      15_000,
      'the final in the compose box',
    );
    await waitFor(
      async () => {
        const shown = await page.locator('.floot-messages').textContent();
        const left = await box.inputValue();
        return Boolean(shown?.includes(finalText)) && left === '';
      },
      15_000,
      'the grace send',
    );
    // 12: page A speaks its own send; page B speaks nothing.
    /** The fake TTS's sentence lines so far. */
    const sentenceLines = () =>
      engineLog(files.ttsLog).filter(line => line.type === 'sentence');
    const firstSpoken = await waitFor(
      () => {
        const lines = sentenceLines();
        return lines.length >= 2 ? lines : undefined;
      },
      20_000,
      'the reply spoken',
    );
    const synthesis = firstSpoken[0].pid;
    // 7: barge-in while the reply plays and its turn runs.
    await page.evaluate(() => globalThis.thixVoiceTest.setLevel(0.3));
    const note = page.locator('.thix-voice-note');
    await waitFor(
      async () => {
        const shown = await note.textContent();
        return Boolean(shown?.includes('continuing in background'));
      },
      10_000,
      'continuing in background…',
    );
    await waitFor(
      () => {
        try {
          process.kill(synthesis, 0);
          return false;
        } catch {
          return true;
        }
      },
      10_000,
      'the playback synthesis ended',
    );
    const atBargeIn = sentenceLines().map(line => line.text);
    t.deepEqual(
      atBargeIn,
      REPLY.slice(0, atBargeIn.length),
      'one playback, in order: page B speaks nothing',
    );
    t.true(atBargeIn.length < REPLY.length, 'the playback stopped early');
    await page.waitForTimeout(800);
    await page.evaluate(() => globalThis.thixVoiceTest.setLevel(0));
    // The new utterance is sent behind the running turn; both complete.
    await waitFor(
      async () => {
        const history = await E(session).getHistoryPage();
        const settled = history.turns.filter((/** @type {any} */ turn) =>
          turn.records.some(
            (/** @type {any} */ r) =>
              r.kind === 'turn-settled' && r.status === 'completed',
          ),
        );
        return settled.length >= 2;
      },
      30_000,
      'both turns completed',
    );
    // 18: the wake lock was held while the mic was on; released after.
    await mic.click();
    t.is((await mic.textContent())?.trim(), 'Start listening');
    const wake = await waitFor(
      async () => {
        const log = await page.evaluate(() => globalThis.thixVoiceTest.wake);
        return log.at(-1)?.[1] === 'release' ? log : undefined;
      },
      15_000,
      'the wake lock released',
    );
    t.is(wake[0][1], 'request screen');
    t.true(
      atBargeIn.length > 0 && sentenceLines().length > atBargeIn.length,
      'the second reply was spoken too',
    );
    // Two assistant messages in one turn must replay independently. Submit
    // via the fixture operator so neither watching page auto-speaks this turn.
    const { turn } = await slice.submit(session, replayPrompt);
    t.is((await E(turn).whenFinished()).state, 'completed');
    const replayTurn = pageB.locator('.thix-turn').filter({
      has: pageB.locator('.floot-msg-row.user', { hasText: replayPrompt }),
    });
    const play = { name: 'Play message', exact: true };
    const buttons = replayTurn.getByRole('button', play);
    await buttons.nth(1).waitFor();
    t.is(await buttons.count(), 2);
    t.is(
      await replayTurn
        .locator('.floot-msg-row.user')
        .getByRole('button', play)
        .count(),
      0,
    );
    const replayLog = () =>
      sentenceLines()
        .map(line => line.text)
        .filter(text => replayParts.includes(text));
    t.deepEqual(replayLog(), []);
    const checkLayout = async (/** @type {number} */ width) => {
      await pageB.setViewportSize({ width, height: 800 });
      const geometry = await replayTurn
        .locator('.floot-msg-row.assistant')
        .evaluateAll((/** @type {Element[]} */ rows) =>
          rows.map(row => {
            const bubble = row.querySelector(':scope > .floot-msg');
            const button = row.querySelector(
              ':scope > .floot-msg + .thix-message-actions button[aria-label="Play message"]',
            );
            if (!bubble || !button)
              throw Error(
                'Expected a Play button beside each assistant bubble',
              );
            const message = bubble.getBoundingClientRect();
            const playRect = button.getBoundingClientRect();
            return {
              gap: playRect.left - message.right,
              bottom: playRect.bottom - message.bottom,
              height: message.height,
              right: playRect.right,
              left: message.left,
            };
          }),
        );
      t.is(geometry.length, 2);
      for (const rect of geometry) {
        t.true(
          rect.gap > 0 && rect.gap <= 8,
          `horizontal gap at ${width}px: ${rect.gap}`,
        );
        t.true(
          Math.abs(rect.bottom) <= 1,
          `bottom alignment at ${width}px: ${rect.bottom}`,
        );
        t.true(
          rect.left >= 0 && rect.right <= width,
          'bubble and control fit inside the viewport',
        );
      }
      const userBubble = await replayTurn
        .locator('.floot-msg-row.user > .floot-msg')
        .boundingBox();
      const firstBubble = await replayTurn
        .locator('.floot-msg-row.assistant > .floot-msg')
        .first()
        .boundingBox();
      const verticalGap = firstBubble.y - (userBubble.y + userBubble.height);
      t.true(
        verticalGap > 0 && verticalGap <= 12,
        `bubble gap at ${width}px: ${verticalGap}`,
      );
      return { geometry, verticalGap };
    };
    const replay = async (
      /** @type {number} */ index,
      /** @type {string[]} */ expected,
    ) => {
      const row = replayTurn.locator('.floot-msg-row.assistant').filter({
        has: pageB.locator('.floot-msg', { hasText: replayParts[index] }),
      });
      await row.getByRole('button', play).click();
      await waitFor(
        () => replayLog().length >= expected.length,
        15_000,
        'the selected assistant message was spoken',
      );
      t.deepEqual(replayLog(), expected);
    };
    const desktop = await checkLayout(1280);
    await replay(1, [replayParts[1]]);
    const mobile = await checkLayout(390);
    t.true(
      mobile.geometry[1].height > desktop.geometry[1].height,
      'the longer bubble wraps on mobile',
    );
    await replay(0, [replayParts[1], replayParts[0]]);
    t.log({ desktop, mobile });
    const pageBWake = await pageB.evaluate(() => globalThis.thixVoiceTest.wake);
    t.deepEqual(pageLog, [], 'no page error');
    t.log({ wake: wake.map(([, what]) => what), pageBWake: pageBWake.length });
  },
);
