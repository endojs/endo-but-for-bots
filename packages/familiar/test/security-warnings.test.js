// @ts-check

import test from 'ava';

import {
  deliverSecurityWarnings,
  SECURITY_WARNINGS_CHANNEL,
} from '../src/security-warnings.js';

/** @param {boolean} loading */
const makeFakeWebContents = loading => {
  /** @type {Array<[string, unknown[]]>} */
  const sent = [];
  /** @type {Array<() => void>} */
  const loadListeners = [];
  return {
    webContents: {
      /**
       * @param {string} channel
       * @param {unknown[]} args
       */
      send: (channel, ...args) => {
        sent.push([channel, args]);
      },
      isLoading: () => loading,
      /**
       * @param {string} event
       * @param {() => void} listener
       */
      on: (event, listener) => {
        if (event === 'did-finish-load') loadListeners.push(listener);
      },
    },
    sent,
    finishLoad: () => {
      for (const listener of loadListeners) listener();
    },
  };
};

test('waits for a loading page before sending', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(true);
  deliverSecurityWarnings(webContents, ['DNS is leaking.']);
  t.deepEqual(sent, [], 'not sent into a page that is still loading');

  finishLoad();
  t.deepEqual(sent, [[SECURITY_WARNINGS_CHANNEL, [['DNS is leaking.']]]]);
});

test('sends at once to a loaded page and again on reload', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, ['a', 'b']);
  t.is(sent.length, 1);

  finishLoad();
  t.is(sent.length, 2);
  t.deepEqual(sent[1], [SECURITY_WARNINGS_CHANNEL, [['a', 'b']]]);
});

test('sends nothing when there are no warnings', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, []);
  finishLoad();
  t.deepEqual(sent, []);
});

test('the channel matches the preload subscription', async t => {
  const { readFile } = await import('node:fs/promises');
  const preload = await readFile(
    new URL('../preload.mjs', import.meta.url),
    'utf8',
  );
  t.true(preload.includes(`'${SECURITY_WARNINGS_CHANNEL}'`));
});
