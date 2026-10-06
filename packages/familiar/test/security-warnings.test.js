// @ts-check

import test from 'ava';

import {
  chatFilePageUrl,
  deliverSecurityWarnings,
  isChatPageUrl,
  makeSecurityWarningReporter,
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

/**
 * @param {string[][]} verdicts - what each successive verification returns
 */
const makeFakeVerifier = verdicts => {
  let calls = 0;
  return {
    verifyDefenses: async () => {
      const verdict = verdicts[Math.min(calls, verdicts.length - 1)];
      calls += 1;
      return verdict;
    },
    callCount: () => calls,
  };
};

/** @param {ReturnType<typeof makeFakeWebContents>} fake */
const makeFakeWindow = fake => {
  let destroyed = false;
  return {
    window: {
      isDestroyed: () => destroyed,
      webContents: fake.webContents,
    },
    destroy: () => {
      destroyed = true;
    },
  };
};

test('a recreated window gets a fresh verdict, not the launch result', async t => {
  const { verifyDefenses, callCount } = makeFakeVerifier([
    ['launch warning'],
    ['later warning'],
  ]);
  const reporter = makeSecurityWarningReporter({ verifyDefenses, chatPageUrl });

  const first = makeFakeWebContents(false);
  await reporter.verifyAndWarn(makeFakeWindow(first).window);
  t.deepEqual(first.sent, [[SECURITY_WARNINGS_CHANNEL, [['launch warning']]]]);

  // The macOS `activate` path: a new window after the first was closed.
  const second = makeFakeWebContents(false);
  await reporter.verifyAndWarn(makeFakeWindow(second).window);
  t.is(callCount(), 2, 'the defenses are verified again');
  t.deepEqual(second.sent, [[SECURITY_WARNINGS_CHANNEL, [['later warning']]]]);
});

test('a reload after re-verification delivers the fresh verdict once', async t => {
  const { verifyDefenses } = makeFakeVerifier([['stale'], ['fresh']]);
  const reporter = makeSecurityWarningReporter({ verifyDefenses, chatPageUrl });
  const fake = makeFakeWebContents(false);
  const { window } = makeFakeWindow(fake);

  await reporter.verifyAndWarn(window);
  // A daemon restart or purge: re-verify, then reload the Chat page.
  await reporter.verifyAndWarn(window);
  fake.sent.length = 0;
  fake.finishLoad();
  t.deepEqual(
    fake.sent,
    [[SECURITY_WARNINGS_CHANNEL, [['fresh']]]],
    'the reload gets the new verdict, sent once, never the launch snapshot',
  );
});

test('a window that started clean still receives a later warning', async t => {
  const { verifyDefenses } = makeFakeVerifier([[], ['DNS is leaking.']]);
  const reporter = makeSecurityWarningReporter({ verifyDefenses, chatPageUrl });
  const fake = makeFakeWebContents(false);
  const { window } = makeFakeWindow(fake);

  await reporter.verifyAndWarn(window);
  t.deepEqual(fake.sent, []);

  await reporter.verifyAndWarn(window);
  fake.sent.length = 0;
  fake.finishLoad();
  t.deepEqual(fake.sent, [[SECURITY_WARNINGS_CHANNEL, [['DNS is leaking.']]]]);
});

test('a re-verification that comes back clean stops the warnings', async t => {
  const { verifyDefenses } = makeFakeVerifier([['a'], []]);
  const reporter = makeSecurityWarningReporter({ verifyDefenses, chatPageUrl });
  const fake = makeFakeWebContents(false);
  const { window } = makeFakeWindow(fake);

  await reporter.verifyAndWarn(window);
  await reporter.verifyAndWarn(window);
  fake.sent.length = 0;
  fake.finishLoad();
  t.deepEqual(fake.sent, []);
});

test('the reporter logs non-empty verdicts and skips a destroyed window', async t => {
  const { verifyDefenses } = makeFakeVerifier([['a']]);
  /** @type {string[][]} */
  const logged = [];
  const reporter = makeSecurityWarningReporter({
    verifyDefenses,
    chatPageUrl,
    onWarnings: warnings => logged.push(warnings),
  });
  const fake = makeFakeWebContents(false);
  const { window, destroy } = makeFakeWindow(fake);
  destroy();
  await reporter.verifyAndWarn(window);
  t.deepEqual(logged, [['a']]);
  t.deepEqual(fake.sent, []);
});

/**
 * The source of the named top-level arrow function in `electron-main.js`,
 * up to the next top-level declaration.
 *
 * @param {string} source
 * @param {string} name
 */
const topLevelBody = (source, name) => {
  const start = source.indexOf(`const ${name} = `);
  const end = source.indexOf('\nconst ', start + 1);
  return source.slice(start, end);
};

test('electron-main re-verifies before every Chat reload and new window', async t => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../electron-main.js', import.meta.url),
    'utf8',
  );
  for (const name of ['handleRestartDaemon', 'handlePurgeDaemon']) {
    const body = topLevelBody(source, name);
    const reverify = body.indexOf('reverifyBeforeReload(win)');
    const reload = body.indexOf('win.loadURL(');
    t.true(reverify > 0, `${name} re-verifies the defenses`);
    t.true(reverify < reload, `${name} re-verifies before reloading`);
  }
  const activate = source.slice(source.indexOf("app.on('activate'"));
  t.regex(
    activate.slice(0, activate.indexOf('});')),
    /createWindow\(\);\s*securityWarnings\.verifyAndWarn\(mainWindow\)/,
    'a window recreated on activate is verified afresh',
  );
  t.regex(
    source,
    /try \{\s*await securityWarnings\.verifyAndWarn\(mainWindow\);\s*\} catch/,
    'a failed startup verification is caught rather than fatal',
  );
  t.notRegex(source, /deliverSecurityWarnings\(/, 'no snapshot replay');
});
