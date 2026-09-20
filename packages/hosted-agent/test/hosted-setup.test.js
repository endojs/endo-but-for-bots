// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Far } from '@endo/far';
import { PINNED_IMAGE_REFERENCE_PATTERN } from '@endo/sandbox/policy.js';

import {
  assertNoRuntimeLeftovers,
  assertRuntimePlacement,
  mintWithPowersPath,
  prepareRuntimeEnv,
  providePrivateDirectory,
  publishAccountOracle,
  readProvisionedEnvironment,
  readSliceImageReference,
  resolveFuturePath,
  resolvePinnedImageRef,
} from '../src/hosted-setup.js';

const key = (...parts) => JSON.stringify(parts.flat());

/** @param {string} p */
// eslint-disable-next-line no-bitwise
const modeOf = async p => (await stat(p)).mode & 0o777;

/** @param {import('ava').ExecutionContext} t */
const makeTmp = async t => {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'hosted-setup-')),
  );
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const makeFakeHost = () => {
  const bindings = new Map();
  const formulas = new Map();
  const environments = new Map();
  /** @type {any[]} */
  const calls = [];
  const seed = (namePath, id, specifier, env) => {
    bindings.set(key(...namePath), id);
    formulas.set(id, {
      type: 'make-unconfined',
      properties: { specifier: { kind: 'literal', value: specifier } },
    });
    environments.set(id, env);
  };
  const host = harden({
    async identify(...parts) {
      return bindings.get(key(...parts));
    },
    async has(...parts) {
      return bindings.has(key(...parts));
    },
    async diagnostics() {
      return harden({ getFormula: async id => formulas.get(id) });
    },
    async getFormulaEnvironment(id) {
      return environments.get(id);
    },
    async copy(from, to) {
      calls.push(['copy', from, to]);
      bindings.set(key(...to), bindings.get(key(...from)));
    },
    async remove(...parts) {
      calls.push(['remove', parts]);
      bindings.delete(key(...parts));
    },
    async makeUnconfined(worker, specifier, options) {
      calls.push(['mint', worker, specifier, options]);
      bindings.set(key(options.resultName), `minted-${specifier}`);
    },
  });
  return { host, seed, bindings, calls };
};

test('a provisioned formula is read by its verified entrypoint and named by its last segment', async t => {
  const { host, seed } = makeFakeHost();
  seed(['adapter', 'service'], 'service-id', 'file:///service.js', {
    SETTING: 'value',
  });
  t.deepEqual(
    await readProvisionedEnvironment(host, {
      label: 'Adapter',
      namePath: ['adapter', 'service'],
      expectedSpecifier: 'file:///service.js',
    }),
    { identifier: 'service-id', env: { SETTING: 'value' } },
  );
  await t.throwsAsync(
    readProvisionedEnvironment(host, {
      label: 'Adapter',
      namePath: ['adapter', 'missing'],
      expectedSpecifier: 'file:///service.js',
    }),
    { message: /Cannot identify Adapter "missing"/ },
  );
  await t.throwsAsync(
    readProvisionedEnvironment(host, {
      label: 'Adapter',
      namePath: ['adapter', 'service'],
      expectedSpecifier: 'file:///other.js',
    }),
    {
      message:
        /Adapter service has an unsupported entrypoint\. Retire the old runtime/,
    },
  );
});

test('future paths resolve through existing ancestors and refuse dangling links', async t => {
  const tmp = await makeTmp(t);
  t.is(
    await resolveFuturePath(path.join(tmp, 'future', 'root')),
    path.join(tmp, 'future', 'root'),
  );
  const alias = path.join(tmp, 'alias');
  await symlink(tmp, alias);
  t.is(
    await resolveFuturePath(path.join(alias, 'future')),
    path.join(tmp, 'future'),
    'an existing link is canonicalized',
  );
  await symlink(path.join(tmp, 'nowhere'), path.join(tmp, 'dangling'));
  await t.throwsAsync(
    resolveFuturePath(path.join(tmp, 'dangling', 'child'), 'Adapter'),
    { message: /Adapter storage path has an unresolved symlink/ },
  );
});

test('runtime placement requires a private directory disjoint from every guest root', async t => {
  const tmp = await makeTmp(t);
  const runtime = path.join(tmp, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const roots = {
    workspaceDir: path.join(tmp, 'ws'),
    stateDir: path.join(tmp, 'state'),
  };
  t.is(await assertRuntimePlacement(runtime, roots), runtime);
  await t.throwsAsync(
    assertRuntimePlacement(
      runtime,
      { ...roots, mcpDir: path.join(runtime, 'mcp') },
      'Adapter',
    ),
    { message: /disjoint from Adapter guest storage roots/ },
  );
  await t.throwsAsync(
    assertRuntimePlacement(runtime, { bad: 'relative' }, 'Adapter'),
    {
      message: /Adapter storage roots must be absolute/,
    },
  );
  await chmod(runtime, 0o755);
  await t.throwsAsync(assertRuntimePlacement(runtime, roots), {
    message: /must be private/,
  });
  await chmod(runtime, 0o700);
  const env = await prepareRuntimeEnv(
    {
      ENDO_SANDBOX_RUNTIME_DIR: runtime,
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    },
    'owner-a',
    roots,
  );
  t.deepEqual(env, {
    ENDO_SANDBOX_RUNTIME_DIR: runtime,
    ENDO_SANDBOX_OWNER_ID: 'owner-a',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
});

test('runtime leftovers under the label are refused, never removed; other labels are not judged', async t => {
  const tmp = await makeTmp(t);
  await assertNoRuntimeLeftovers(tmp, 'owner-a');
  await symlink('endo-sandbox-owner-v1-stale', path.join(tmp, 'owner-a.owner'));
  await t.throwsAsync(assertNoRuntimeLeftovers(tmp, 'owner-a'), {
    message: /still holds .*owner-a\.owner": the native runtime would claim it/,
  });
  await rm(path.join(tmp, 'owner-a.owner'));
  await mkdir(path.join(tmp, 'owner-a.files'));
  await t.throwsAsync(assertNoRuntimeLeftovers(tmp, 'owner-a'), {
    message: /owner-a\.files"/,
  });
  await assertNoRuntimeLeftovers(tmp, 'owner-b');
});

test('a private directory is created or adopted, never followed through a link', async t => {
  const tmp = await makeTmp(t);
  const fresh = path.join(tmp, 'fresh');
  await providePrivateDirectory('SETTING', fresh);
  t.is(await modeOf(fresh), 0o700);
  await chmod(fresh, 0o755);
  await providePrivateDirectory('SETTING', fresh);
  t.is(await modeOf(fresh), 0o700, 'a loose mode is tightened');
  await symlink(fresh, path.join(tmp, 'link'));
  await t.throwsAsync(
    providePrivateDirectory('SETTING', path.join(tmp, 'link')),
    {
      message: /SETTING must not be a symlink/,
    },
  );
});

test('a caplet minted with powers by path aliases the capability only for the mint', async t => {
  const { host, seed, bindings, calls } = makeFakeHost();
  seed(['adapter', 'provider'], 'provider-id', 'file:///provider.js', {});
  await mintWithPowersPath(host, {
    powersPath: ['adapter', 'provider'],
    temporary: 'adapter.provider-powers',
    specifier: 'file:///owner.js',
    resultName: ['adapter', 'owner'],
    env: { ROOT: '/srv' },
  });
  t.deepEqual(
    calls.map(call => call[0]),
    ['copy', 'mint', 'remove'],
  );
  t.is(calls[1][3].powersName, 'adapter.provider-powers');
  t.false(bindings.has(key('adapter.provider-powers')), 'the alias is gone');
  t.true(bindings.has(key('adapter', 'owner')));
});

test('slice image references are checked without Podman and pinned through it', async t => {
  t.deepEqual(readSliceImageReference('oci:localhost/x:latest'), {
    image: 'localhost/x:latest',
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  t.deepEqual(readSliceImageReference(`localhost/x@${digest}`), {
    image: `localhost/x@${digest}`,
    imageDigest: digest,
  });
  t.throws(() => readSliceImageReference('oci:-rm', 'Adapter'), {
    message: /Invalid Adapter sandbox image "-rm"/,
  });
  t.throws(
    () => readSliceImageReference('oci:localhost/x@sha256:zzz', 'Adapter'),
    {
      message: /Adapter sandbox image digest is invalid/,
    },
  );
  /** @type {string[][]} */
  const inspected = [];
  const exec = async (file, args) => {
    inspected.push([file, ...args]);
    return { stdout: `${digest}\n` };
  };
  // The tag names where the image was FOUND; the digest is the pin. Keeping
  // both produces `name:tag@digest`, which Podman accepts and the native
  // runtime refuses, so a resolver that called it pinned sent every session to
  // "Native profile requires a pinned OCI image".
  t.deepEqual(await resolvePinnedImageRef('oci:localhost/x:latest', exec), {
    imageRef: `localhost/x@${digest}`,
    imageDigest: digest,
  });
  t.true(
    PINNED_IMAGE_REFERENCE_PATTERN.test(`localhost/x@${digest}`),
    'what this resolver returns is what the runtime accepts',
  );
  t.false(PINNED_IMAGE_REFERENCE_PATTERN.test(`localhost/x:latest@${digest}`));
  // The tag is still what Podman is asked about.
  t.deepEqual(inspected, [
    [
      'podman',
      'image',
      'inspect',
      '--format',
      '{{.Digest}}',
      'localhost/x:latest',
    ],
  ]);
  // A registry port is not a tag: the colon before the last slash stays.
  t.deepEqual(
    await resolvePinnedImageRef('oci:registry.example:5000/x:v2', exec),
    { imageRef: `registry.example:5000/x@${digest}`, imageDigest: digest },
  );
  t.deepEqual(
    await resolvePinnedImageRef('oci:registry.example:5000/x', exec),
    { imageRef: `registry.example:5000/x@${digest}`, imageDigest: digest },
  );
  t.deepEqual(await resolvePinnedImageRef(`oci:localhost/x@${digest}`, exec), {
    imageRef: `localhost/x@${digest}`,
    imageDigest: digest,
  });
  t.is(inspected.length, 3, 'a pinned reference is not resolved again');
  await t.throwsAsync(
    resolvePinnedImageRef(
      'oci:localhost/x:latest',
      async () => ({ stdout: 'nope\n' }),
      'Adapter',
    ),
    { message: /Cannot resolve a digest for Adapter sandbox image/ },
  );
});

/**
 * A host agent that records names as a flat map of joined paths.
 * @param initial
 */
const makeNamingHost = initial => {
  const names = new Map(Object.entries(initial));
  const guests = new Map();
  const made = [];
  const joined = namePath =>
    (Array.isArray(namePath) ? namePath : [namePath]).join('/');
  const host = Far('host', {
    has: async (...namePath) => names.has(joined(namePath)),
    locate: async (...namePath) => `locator:${names.get(joined(namePath))}`,
    remove: async (...namePath) => {
      names.delete(joined(namePath));
    },
    provideGuest: async (handleName, { agentName }) => {
      const stored = new Map();
      const guest = Far('guest', {
        storeLocator: async (name, locator) => {
          stored.set(name, locator);
        },
      });
      guests.set(agentName, stored);
      names.set(handleName, `handle:${agentName}`);
      names.set(agentName, guest);
    },
    lookup: async namePath => names.get(joined(namePath)),
    makeUnconfined: async (_worker, specifier, options) => {
      made.push({
        specifier,
        ...options,
        powers: names.get(joined(options.powersName)),
      });
      names.set(joined(options.resultName), `formula-${made.length}`);
    },
    move: async (from, to) => {
      names.set(joined(to), names.get(joined(from)));
      names.delete(joined(from));
    },
    copy: async (from, to) => {
      names.set(joined(to), names.get(joined(from)));
    },
  });
  return { host, names, guests, made };
};

test('an account oracle is made once, keeps its identity, and follows a re-minted broker', async t => {
  const world = makeNamingHost({
    'codex-sandbox/broker-service': 'broker-1',
    'floot/controller-profile': 'profile',
  });
  const options = {
    label: 'Codex',
    dir: 'codex-sandbox',
    providerId: 'codex',
    flootDir: 'floot',
    backendId: 'codex',
  };
  await publishAccountOracle(world.host, options);
  const oracles = () =>
    world.made.filter(made =>
      made.specifier.endsWith('/account-oracle-module.js'),
    );
  const sources = () =>
    world.made.filter(made =>
      made.specifier.endsWith('/account-source-module.js'),
    );
  t.is(oracles().length, 1);
  t.deepEqual(oracles()[0].resultName, ['codex-sandbox', 'account-oracle']);
  t.deepEqual(oracles()[0].env, { ACCOUNT_PROVIDER_ID: 'codex' });
  // The source formula's powers are the broker service; the oracle's
  // namespace holds that source and never the broker.
  t.is(sources().length, 1);
  t.is(sources()[0].powers, 'broker-1');
  const powers = world.guests.get('codex-sandbox.account-oracle-powers');
  t.deepEqual([...powers.keys()], ['account-source']);
  // The names used while making it are tucked under the adapter's directory.
  t.false(world.names.has('codex-sandbox.account-oracle-powers'));
  t.false(world.names.has('codex-sandbox.account-source-powers'));
  t.true(world.names.has('codex-sandbox/account-oracle-powers'));
  // Floot finds it under the backend's id.
  t.is(
    world.names.get('floot/controller-profile/codex-account'),
    world.names.get('codex-sandbox/account-oracle'),
  );

  // A deploy re-mints the broker. The oracle is not made again; the source
  // is, over the new broker, and the name inside the namespace moves to it.
  const before = powers.get('account-source');
  world.names.set('codex-sandbox/broker-service', 'broker-2');
  await publishAccountOracle(world.host, options);
  t.is(oracles().length, 1);
  t.is(sources().length, 2);
  t.is(sources()[1].powers, 'broker-2');
  t.not(powers.get('account-source'), before);
});

test('an oracle that cannot be provided is reported and does not fail setup', async t => {
  const world = makeNamingHost({});
  await t.notThrowsAsync(() =>
    publishAccountOracle(world.host, {
      label: 'Codex',
      dir: 'codex-sandbox',
      providerId: 'codex',
      flootDir: 'floot',
      backendId: 'codex',
    }),
  );
  t.is(world.made.length, 0);
});
