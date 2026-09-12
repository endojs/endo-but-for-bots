// @ts-check
import '@endo/init';
import test from 'ava';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { main } from '../setup-host.js';

const key = (...parts) => JSON.stringify(parts.flat());

const makeFakeHost = () => {
  const bindings = new Map();
  const mints = [];
  return {
    bindings,
    mints,
    host: {
      async has(...parts) {
        return bindings.has(key(...parts));
      },
      async makeDirectory(...parts) {
        bindings.set(key(...parts), 'dir');
      },
      async makeUnconfined(worker, specifier, options) {
        mints.push({ worker, specifier, options });
        const result = Array.isArray(options.resultName)
          ? options.resultName
          : [options.resultName];
        bindings.set(key(...result), 'cap');
      },
      async identify() {
        return 'fake-host-id';
      },
    },
  };
};

const withStateDir = async (t, value) => {
  const previous = process.env.ENDO_OPENCODE_STATE_DIR;
  if (value === undefined) {
    delete process.env.ENDO_OPENCODE_STATE_DIR;
  } else {
    process.env.ENDO_OPENCODE_STATE_DIR = value;
  }
  t.teardown(() => {
    if (previous === undefined) {
      delete process.env.ENDO_OPENCODE_STATE_DIR;
    } else {
      process.env.ENDO_OPENCODE_STATE_DIR = previous;
    }
  });
};

const makeTmp = async (t, prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test.serial('mints the factory, mounter, and state provider', async t => {
  const tmp = await makeTmp(t, 'setup-host-state-');
  const stateDir = path.join(tmp, 'state');
  await withStateDir(t, stateDir);
  const { host, bindings, mints } = makeFakeHost();
  await main(host);

  t.deepEqual(
    mints.map(mint => mint.options.resultName),
    [
      ['opencode-sandbox', 'sandbox-factory'],
      ['opencode-sandbox', 'fs-mounter'],
      ['opencode-sandbox', 'state-provider'],
    ],
  );
  t.true(bindings.has(key('opencode-sandbox', 'state-provider')));
  t.is(
    mints[2].options.env.ENDO_OPENCODE_STATE_DIR,
    stateDir,
    'the provider is given the validated state root',
  );
  t.regex(
    mints[0].options.env.ENDO_SANDBOX_OWNER_ID,
    /^opencode-[0-9a-f]{64}$/,
  );
});

test.serial('rejects a relative state root before minting', async t => {
  await withStateDir(t, 'relative/opencode-state');
  const { host, mints } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /must be absolute/ });
  t.is(mints.length, 0);
});

test.serial('rejects the filesystem root', async t => {
  await withStateDir(t, '/');
  const { host, mints } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /normalized, non-root/ });
  t.is(mints.length, 0);
});

test.serial('rejects a symlinked state root', async t => {
  const target = await makeTmp(t, 'setup-host-target-');
  const link = `${await makeTmp(t, 'setup-host-link-')}-link`;
  await symlink(target, link);
  t.teardown(() => rm(link, { force: true }));
  await withStateDir(t, link);
  const { host, bindings, mints } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /must not be a symlink/ });
  t.false(
    bindings.has(key('opencode-sandbox', 'state-provider')),
    'no provider is minted against a rejected root',
  );
  t.is(mints.length, 2, 'factory and mounter are harmless pre-state mints');
});

test.serial('rejects a state root that is a file', async t => {
  const dir = await makeTmp(t, 'setup-host-file-');
  const file = path.join(dir, 'state');
  await writeFile(file, 'not a directory\n');
  await withStateDir(t, file);
  const { host, bindings } = makeFakeHost();
  await t.throwsAsync(main(host), { message: /must be a directory/ });
  t.false(bindings.has(key('opencode-sandbox', 'state-provider')));
});

test.serial(
  'adopts an existing private root but refuses a foreign-owned one',
  async t => {
    const tmp = await makeTmp(t, 'setup-host-adopt-');
    const stateDir = path.join(tmp, 'state');
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o755);
    await withStateDir(t, stateDir);
    const { host, bindings } = makeFakeHost();
    await main(host);
    t.true(bindings.has(key('opencode-sandbox', 'state-provider')));
    t.is((await stat(stateDir)).mode % 0o1000, 0o700, 'loose mode tightened');
  },
);
