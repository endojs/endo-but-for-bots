// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  defineProfile,
  getProfile,
  listProfiles,
  ensureProfileDir,
  PROFILE_DIR,
} from '../src/backend/profiles.js';

/**
 * A minimal in-memory fake of the EndoHost surface profiles use:
 * makeDirectory / storeValue / lookup / list / has, over a nested name tree.
 * Path arguments arrive as either a single name string or an array of segments.
 */
const makeFakeHost = () => {
  /** @type {Map<string, unknown>} */
  const dirs = new Map(); // dirName -> Map(name -> value)
  /** @param {string | string[]} nameOrPath */
  const toPath = nameOrPath =>
    Array.isArray(nameOrPath) ? nameOrPath : [nameOrPath];
  return harden({
    /** @param {...string} path */
    has: async (...path) => {
      if (path.length === 1) return dirs.has(path[0]);
      const dir = /** @type {Map<string, unknown>} */ (dirs.get(path[0]));
      return dir !== undefined && dir.has(path[1]);
    },
    /** @param {string | string[]} nameOrPath */
    makeDirectory: async nameOrPath => {
      const [name] = toPath(nameOrPath);
      if (!dirs.has(name)) dirs.set(name, new Map());
      return undefined;
    },
    /**
     * @param {unknown} value
     * @param {string | string[]} nameOrPath
     */
    storeValue: async (value, nameOrPath) => {
      const [dir, name] = toPath(nameOrPath);
      const d = /** @type {Map<string, unknown>} */ (dirs.get(dir));
      if (d === undefined) throw new Error(`no directory ${dir}`);
      d.set(name, value);
      return undefined;
    },
    /** @param {string | string[]} nameOrPath */
    lookup: async nameOrPath => {
      const [dir, name] = toPath(nameOrPath);
      const d = /** @type {Map<string, unknown>} */ (dirs.get(dir));
      if (d === undefined) throw new Error(`no directory ${dir}`);
      return d.get(name);
    },
    /** @param {...string} path */
    list: async (...path) => {
      const d = /** @type {Map<string, unknown>} */ (dirs.get(path[0]));
      return d === undefined ? [] : [...d.keys()];
    },
  });
};

test('defineProfile stores the full tuple and ensures the directory', async t => {
  const host = makeFakeHost();
  const masked = await defineProfile(host, {
    name: 'openai-main',
    provider: 'openai',
    apiKey: 'sk-secret-123',
    baseUrl: 'https://api.openai.com',
  });
  t.true(await host.has(PROFILE_DIR));
  // The return value is already masked.
  t.deepEqual(masked, {
    name: 'openai-main',
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
  });
  t.is(/** @type {Record<string, unknown>} */ (masked).apiKey, undefined);
});

test('getProfile returns the full tuple INCLUDING the apiKey (backend only)', async t => {
  const host = makeFakeHost();
  await defineProfile(host, {
    name: 'anthropic-main',
    provider: 'anthropic',
    apiKey: 'sk-ant-456',
  });
  const full = await getProfile(host, 'anthropic-main');
  t.is(full.apiKey, 'sk-ant-456');
  t.is(full.provider, 'anthropic');
});

test('listProfiles MASKS the apiKey — it never returns the secret', async t => {
  const host = makeFakeHost();
  await defineProfile(host, {
    name: 'p1',
    provider: 'openai',
    apiKey: 'sk-MUST-NOT-LEAK',
    baseUrl: 'https://x',
  });
  await defineProfile(host, {
    name: 'p2',
    provider: 'ollama',
    apiKey: 'sk-ALSO-SECRET',
  });
  const list = await listProfiles(host);
  t.is(list.length, 2);
  for (const masked of list) {
    t.is(/** @type {Record<string, unknown>} */ (masked).apiKey, undefined);
    t.true('provider' in masked);
    t.true('name' in masked);
  }
  // The serialized masked view must not contain either secret.
  const serialized = JSON.stringify(list);
  t.false(serialized.includes('MUST-NOT-LEAK'));
  t.false(serialized.includes('ALSO-SECRET'));
});

test('listProfiles is empty when the directory does not exist', async t => {
  const host = makeFakeHost();
  const list = await listProfiles(host);
  t.deepEqual(list, []);
});

test('ensureProfileDir is idempotent', async t => {
  const host = makeFakeHost();
  await ensureProfileDir(host);
  await ensureProfileDir(host);
  t.true(await host.has(PROFILE_DIR));
});

test('defineProfile rejects empty name / provider / apiKey', async t => {
  const host = makeFakeHost();
  await t.throwsAsync(
    defineProfile(host, {
      name: '',
      provider: 'openai',
      apiKey: 'k',
    }),
    { message: /name must be/ },
  );
  await t.throwsAsync(
    defineProfile(host, {
      name: 'n',
      provider: '',
      apiKey: 'k',
    }),
    { message: /provider must be/ },
  );
  await t.throwsAsync(
    defineProfile(host, {
      name: 'n',
      provider: 'openai',
      apiKey: '',
    }),
    { message: /apiKey must be/ },
  );
});
