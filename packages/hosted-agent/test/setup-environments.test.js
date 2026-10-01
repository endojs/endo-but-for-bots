// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../setup-environments.js';

test('environment setup persists null powers and bounded operator env, retains formula on rerun', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'environment-setup-'));
  t.teardown(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const store = new Map();
  const mints = [];
  let stored;
  const key = names => names.flat().join('/');
  const host = Far('Host', {
    has: (...names) => store.has(key(names)),
    identify: (...names) =>
      key(names) === '@agent' ? 'host-identity' : 'runner-identity',
    diagnostics: () =>
      Far('Diagnostics', {
        getFormula: () =>
          harden({
            type: 'make-unconfined',
            properties: {
              specifier: { kind: 'literal', value: stored.specifier },
            },
          }),
      }),
    getFormulaEnvironment: () => stored.options.env,
    makeDirectory: names => {
      store.set(key(names), Far('Directory'));
    },
    storeValue: (value, name) => {
      store.set(name, value);
    },
    remove: name => {
      store.delete(name);
    },
    makeUnconfined: (_worker, specifier, options) => {
      t.is(store.get(options.powersName), null);
      stored = { specifier, options };
      mints.push(stored);
      store.set(key(options.resultName), Far('Runner'));
    },
  });
  const env = harden({
    HOME: directory,
    PATH: '/usr/bin:/bin',
    ANTHROPIC_API_KEY: 'never-copy',
    CODEX_TOKEN: 'never-copy',
    HTTP_PROXY: 'never-copy',
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '1048576',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    ENDO_ENVIRONMENT_IMAGE_REF: `localhost/dev@sha256:${'a'.repeat(64)}`,
    ENDO_ENVIRONMENT_LISTENER_IMAGE_REF: `localhost/listener@sha256:${'b'.repeat(64)}`,
    ENDO_ENVIRONMENT_STATE_ROOT: join(directory, 'state'),
    ENDO_ENVIRONMENT_NETWORK_DIR: join(directory, 'network'),
    ENDO_ENVIRONMENT_PUBLIC_INTERNET: '1',
    ENDO_NINEP_SUDO: '1',
  });
  await main(host, env);
  await main(host, env);
  await t.throwsAsync(
    main(host, { ...env, ENDO_ENVIRONMENT_PUBLIC_INTERNET: '0' }),
    { message: /configuration changed/ },
  );
  t.is(mints.length, 1);
  t.false(store.has('environment.null-powers'));
  t.false('ANTHROPIC_API_KEY' in stored.options.env);
  t.false('CODEX_TOKEN' in stored.options.env);
  t.false('HTTP_PROXY' in stored.options.env);
  t.is(stored.options.env.ENDO_NINEP_SUDO, '1');
  t.true(String(stored.options.env.ENDO_SANDBOX_OWNER_ID).length <= 56);
  await t.throwsAsync(
    main(host, {
      ...env,
      ENDO_ENVIRONMENT_STATE_ROOT: `${directory}/state/../state`,
    }),
    { message: /normalized absolute/ },
  );
  store.delete('environments/runner');
  await writeFile(
    join(runtime, `${stored.options.env.ENDO_SANDBOX_OWNER_ID}.owner`),
    'stale',
  );
  await t.throwsAsync(main(host, env), { message: /still holds/ });
  t.is(mints.length, 1);
});
