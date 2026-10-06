// @ts-check

import test from 'ava';

import {
  chatFilePageUrl,
  deliverSecurityWarnings,
  isChatPageUrl,
  SECURITY_WARNINGS_CHANNEL,
} from '../src/security-warnings.js';

const chatPageUrl = 'file:///app/dist/index.html';
const chatUrl = `${chatPageUrl}#gateway=x`;

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
  deliverSecurityWarnings(webContents, ['DNS is leaking.'], chatPageUrl);
  t.deepEqual(sent, [], 'not sent into a page that is still loading');

  finishLoad();
  t.deepEqual(sent, [[SECURITY_WARNINGS_CHANNEL, [['DNS is leaking.']]]]);
});

test('sends at once to a loaded page and again on reload', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, ['a', 'b'], chatPageUrl);
  t.is(sent.length, 1);

  finishLoad();
  t.is(sent.length, 2);
  t.deepEqual(sent[1], [SECURITY_WARNINGS_CHANNEL, [['a', 'b']]]);
});

test('sends nothing when there are no warnings', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, [], chatPageUrl);
  finishLoad();
  t.deepEqual(sent, []);
});

test('stops at a page other than Chat and resumes on return', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, ['a'], chatPageUrl);
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
  deliverSecurityWarnings(webContents, ['a'], chatPageUrl);
  t.deepEqual(sent, []);
});

test('stops at a foreign file: page', t => {
  const { webContents, sent, finishLoad } = makeFakeWebContents(false);
  deliverSecurityWarnings(webContents, ['a'], chatPageUrl);
  t.is(sent.length, 1);

  finishLoad('file:///tmp/evil.html');
  t.is(sent.length, 1, 'another local page does not receive the warnings');
});

test('isChatPageUrl accepts only the exact Chat dist page', t => {
  t.true(isChatPageUrl('file:///app/dist/index.html', chatPageUrl));
  t.true(isChatPageUrl('file:///app/dist/index.html#gateway=x', chatPageUrl));
  t.true(isChatPageUrl('file:///app/dist/index.html?a=b', chatPageUrl));
  t.false(isChatPageUrl('file:///tmp/evil.html', chatPageUrl));
  t.false(isChatPageUrl('file:///app/dist/', chatPageUrl));
  t.false(isChatPageUrl('file:///app/dist/index.html/x', chatPageUrl));
  t.false(isChatPageUrl('http://127.0.0.1:5173/', chatPageUrl));
  t.false(isChatPageUrl('localhttp://weblet-1/', chatPageUrl));
  t.false(isChatPageUrl('about:blank', chatPageUrl));
  t.false(isChatPageUrl('', chatPageUrl));
});

test('isChatPageUrl pins the dev server to its port', t => {
  const devPageUrl = 'http://127.0.0.1:5173/';
  t.true(isChatPageUrl('http://127.0.0.1:5173/#gateway=x', devPageUrl));
  t.true(isChatPageUrl('http://127.0.0.1:5173#gateway=x', devPageUrl));
  t.false(isChatPageUrl('http://127.0.0.1:5174/#gateway=x', devPageUrl));
  t.false(isChatPageUrl('http://127.0.0.1/', devPageUrl));
  t.false(isChatPageUrl('http://127.0.0.1:5173/other.html', devPageUrl));
  t.false(isChatPageUrl('https://127.0.0.1:5173/', devPageUrl));
  t.false(isChatPageUrl('http://localhost:5173/', devPageUrl));
  t.false(isChatPageUrl('file:///app/dist/index.html', devPageUrl));
});

test('isChatPageUrl rejects everything when the Chat URL is malformed', t => {
  t.false(isChatPageUrl('', ''));
  t.false(isChatPageUrl('file:///app/dist/index.html', 'not a url'));
});

test('chatFilePageUrl matches the loaded Chat page for an install path needing escapes', t => {
  const chatDistPath = '/opt/My App #2/100%/dist/index.html';
  // What webContents.getURL() reports after loadURL(`${chatPageUrl}#...`).
  const loaded = 'file:///opt/My%20App%20%232/100%25/dist/index.html#gateway=x';
  t.true(isChatPageUrl(loaded, chatFilePageUrl(chatDistPath)));
  // The template literal it replaced cuts the path at `#` and never matches.
  t.false(isChatPageUrl(loaded, `file://${chatDistPath}`));
});

test('the channel matches the preload subscription', async t => {
  const { readFile } = await import('node:fs/promises');
  const preload = await readFile(
    new URL('../preload.mjs', import.meta.url),
    'utf8',
  );
  t.true(preload.includes(`'${SECURITY_WARNINGS_CHANNEL}'`));
});
