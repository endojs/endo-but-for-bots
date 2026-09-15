// @ts-check
import '@endo/init';
import test from 'ava';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { make } from '../src/opencode-state-provider-module.js';

const makeFakeHost = () => {
  const names = new Set();
  const key = name => JSON.stringify(name);
  return harden({
    async has(...name) {
      return names.has(key(name));
    },
    async makeDirectory(name) {
      names.add(key(name));
    },
    async provideMount(directory) {
      return harden({ path: () => directory });
    },
    async remove(...name) {
      names.delete(key(name));
    },
  });
};

const makeRoot = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-state-module-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  return root;
};

const setProcessStateDir = (t, value) => {
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

test.serial('uses ENDO_OPENCODE_STATE_DIR from the formula env', async t => {
  setProcessStateDir(t, undefined);
  const root = await makeRoot(t);
  const provider = make(makeFakeHost(), undefined, {
    env: { ENDO_OPENCODE_STATE_DIR: root },
  });
  t.is(typeof provider.help, 'function');
  await provider.provideSessionMount('ses-1');
  t.true((await stat(path.join(root, 'ses-1'))).isDirectory());
});

test.serial('falls back to the daemon process env', async t => {
  const root = await makeRoot(t);
  setProcessStateDir(t, root);
  const provider = make(makeFakeHost(), undefined, {});
  await provider.provideSessionMount('ses-2');
  t.true((await stat(path.join(root, 'ses-2'))).isDirectory());
});

test.serial('prefers the formula env to the process env', async t => {
  const formulaRoot = await makeRoot(t);
  const processRoot = await makeRoot(t);
  setProcessStateDir(t, processRoot);
  const provider = make(makeFakeHost(), undefined, {
    env: { ENDO_OPENCODE_STATE_DIR: formulaRoot },
  });
  await provider.provideSessionMount('ses-3');
  t.true((await stat(path.join(formulaRoot, 'ses-3'))).isDirectory());
  await t.throwsAsync(stat(path.join(processRoot, 'ses-3')), {
    code: 'ENOENT',
  });
});

test.serial('requires ENDO_OPENCODE_STATE_DIR', async t => {
  setProcessStateDir(t, undefined);
  t.throws(() => make(makeFakeHost(), undefined, {}), {
    message: /ENDO_OPENCODE_STATE_DIR is required/,
  });
});
