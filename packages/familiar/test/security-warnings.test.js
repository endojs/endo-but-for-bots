// @ts-check

import test from 'ava';

import {
  deliverSecurityWarnings,
  isChatPageUrl,
  SECURITY_WARNINGS_CHANNEL,
} from '../src/security-warnings.js';

const chatUrl = 'file:///app/dist/index.html#gateway=x';

/**
 * @param {boolean} loading
 * @param {string} [initialUrl]
 */
const makeFakeWebContents = (loading, initialUrl = chatUrl) => {
  let url = initialUrl;
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
      getURL: () => url,
      /**
       * @param {string} event
       * @param {() => void} listener
       */
      on: (event, listener) => {
        if (event === 'did-finish-load') loadListeners.push(listener);
      },
    },
    sent,
    /** @param {string} [nextUrl] */
    finishLoad: (nextUrl = url) => {
      url = nextUrl;
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

test('stops at a page other than Chat and resumes on return', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, ['a']);
  t.is(sent.length, 1);

  finishLoad('localhttp://weblet-1/index.html');
  t.is(sent.length, 1, 'a weblet does not receive the warnings');

  finishLoad(chatUrl);
  t.is(sent.length, 2);
});

test('sends nothing when the first page is not Chat', t => {
  const { webContents, sent } = makeFakeWebContents(
    false,
    'localhttp://weblet-1/',
  );
  deliverSecurityWarnings(webContents, ['a']);
  t.deepEqual(sent, []);
});

test('isChatPageUrl accepts only the file: and loopback dev pages', t => {
  t.true(isChatPageUrl('file:///app/dist/index.html'));
  t.true(isChatPageUrl('http://127.0.0.1:5173/#gateway=x'));
  t.false(isChatPageUrl('localhttp://weblet-1/'));
  t.false(isChatPageUrl('https://example.com/'));
  t.false(isChatPageUrl('http://example.com/'));
  t.false(isChatPageUrl('about:blank'));
  t.false(isChatPageUrl(''));
});

test('the channel matches the preload subscription', async t => {
  const { readFile } = await import('node:fs/promises');
  const preload = await readFile(
    new URL('../preload.mjs', import.meta.url),
    'utf8',
  );
  t.true(preload.includes(`'${SECURITY_WARNINGS_CHANNEL}'`));
});
