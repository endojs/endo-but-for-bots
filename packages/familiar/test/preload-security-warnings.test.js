// @ts-check

import { readFile } from 'node:fs/promises';

import test from 'ava';

import { SECURITY_WARNINGS_CHANNEL } from '../src/security-warnings.js';

/** @import { ExecutionContext } from 'ava' */

const electronImport = "import { contextBridge, ipcRenderer } from 'electron';";

let loadCount = 0;

/**
 * Evaluate a fresh copy of `preload.mjs` against a stub of the `electron`
 * module, returning the exposed `window.familiar` and a way to deliver an
 * IPC message as the main process would.
 *
 * @param {ExecutionContext} t
 */
const loadPreload = async t => {
  const source = await readFile(
    new URL('../preload.mjs', import.meta.url),
    'utf8',
  );
  t.true(
    source.includes(electronImport),
    'preload imports electron as expected',
  );

  /** @type {Map<string, (event: unknown, ...args: unknown[]) => void>} */
  const handlers = new Map();
  /** @type {Record<string, any>} */
  const exposed = {};
  const stub = {
    contextBridge: {
      exposeInMainWorld: (
        /** @type {string} */ key,
        /** @type {any} */ api,
      ) => {
        exposed[key] = api;
      },
    },
    ipcRenderer: {
      on: (
        /** @type {string} */ channel,
        /** @type {(event: unknown, ...args: unknown[]) => void} */ handler,
      ) => {
        handlers.set(channel, handler);
      },
      invoke: async () => undefined,
    },
  };
  loadCount += 1;
  const key = `__familiarPreloadStub${loadCount}`;
  /** @type {any} */ (globalThis)[key] = stub;
  t.teardown(() => {
    delete (/** @type {any} */ (globalThis)[key]);
  });
  const stubbed = source.replace(
    electronImport,
    `const { contextBridge, ipcRenderer } = globalThis.${key};`,
  );
  await import(
    `data:text/javascript;base64,${Buffer.from(stubbed).toString('base64')}`
  );

  /** @param {string[]} warnings */
  const receive = warnings => {
    const handler = handlers.get(SECURITY_WARNINGS_CHANNEL);
    if (!handler) throw Error('preload did not subscribe to the channel');
    handler({}, warnings);
  };
  return { familiar: exposed.familiar, receive };
};

test('replays warnings that arrived before the subscription', async t => {
  const { familiar, receive } = await loadPreload(t);
  receive(['DNS is leaking.']);

  /** @type {string[][]} */
  const got = [];
  familiar.onSecurityWarnings((/** @type {string[]} */ w) => got.push(w));
  t.deepEqual(got, [['DNS is leaking.']]);
});

test('a subscriber before any warning receives nothing until one arrives', async t => {
  const { familiar, receive } = await loadPreload(t);
  /** @type {string[][]} */
  const got = [];
  familiar.onSecurityWarnings((/** @type {string[]} */ w) => got.push(w));
  t.deepEqual(got, []);

  receive(['a']);
  t.deepEqual(got, [['a']]);
});

test('every subscriber receives later warnings after the replay', async t => {
  const { familiar, receive } = await loadPreload(t);
  receive(['a']);

  /** @type {string[][]} */
  const first = [];
  /** @type {string[][]} */
  const second = [];
  familiar.onSecurityWarnings((/** @type {string[]} */ w) => first.push(w));
  familiar.onSecurityWarnings((/** @type {string[]} */ w) => second.push(w));

  receive(['a', 'b']);
  t.deepEqual(first, [['a'], ['a', 'b']]);
  t.deepEqual(second, [['a'], ['a', 'b']]);
});

test('a throwing subscriber does not starve the others', async t => {
  const { familiar, receive } = await loadPreload(t);
  /** @type {string[][]} */
  const got = [];
  familiar.onSecurityWarnings(() => {
    throw Error('subscriber failure');
  });
  familiar.onSecurityWarnings((/** @type {string[]} */ w) => got.push(w));

  const originalError = console.error;
  console.error = () => {};
  try {
    receive(['a']);
  } finally {
    console.error = originalError;
  }
  t.deepEqual(got, [['a']]);
});

test('onSecurityWarnings returns nothing across the bridge', async t => {
  const { familiar } = await loadPreload(t);
  t.is(
    familiar.onSecurityWarnings(() => {}),
    undefined,
  );
});
