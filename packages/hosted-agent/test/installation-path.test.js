// @ts-check
import '@endo/init';
import test from 'ava';

// Each scenario deliberately runs a sequence against the same namespace.
/* eslint-disable no-await-in-loop */

import {
  installationPath,
  migrateBackendInstallation,
  provideInstallationDirectory,
} from '../src/installation-path.js';

const fixture = () => {
  const directories = new Map([['pins', new Map()]]);
  const root = new Map([['@pins', 'pins']]);
  const key = path => {
    let directory = root;
    for (const part of path.slice(0, -1)) {
      directory = directories.get(directory.get(part));
      if (!directory) throw Error('Missing parent');
    }
    return { directory, name: path.at(-1) };
  };
  const identify = (...path) => {
    const { directory, name } = key(path);
    return directory.get(name);
  };
  const writes = [];
  const host = harden({
    has: (...path) => identify(...path) !== undefined,
    identify,
    /**
     * @param {string[]} path
     * @param {{adoptFrom?: string[], keepSource?: boolean}} [options]
     */
    provideDirectory: (path, { adoptFrom, keepSource = false } = {}) => {
      const source = adoptFrom ? identify(...adoptFrom) : undefined;
      for (let length = 1; length <= path.length; length += 1) {
        const prefix = path.slice(0, length);
        const { directory, name } = key(prefix);
        if (length === path.length && source) {
          const retained = directory.get(name);
          if (retained && retained !== source)
            throw Error('Conflicting directory adoption bindings');
          if (!retained) {
            directory.set(name, source);
            writes.push(['copy', adoptFrom, path]);
          }
          if (!keepSource) {
            const origin = key(adoptFrom);
            origin.directory.delete(origin.name);
            writes.push(['remove', adoptFrom]);
          }
        } else if (!directory.has(name)) {
          const id = `directory-${directories.size}`;
          directories.set(id, new Map());
          directory.set(name, id);
          writes.push(['directory', prefix]);
        }
      }
    },
    makeDirectory: path => {
      const { directory, name } = key(path);
      const id = `directory-${directories.size}`;
      directories.set(id, new Map());
      directory.set(name, id);
      writes.push(['directory', path]);
    },
    copy: (from, to) => {
      const { directory, name } = key(to);
      directory.set(name, identify(...from));
      writes.push(['copy', from, to]);
    },
    remove: (...path) => {
      const { directory, name } = key(path);
      directory.delete(name);
      writes.push(['remove', path]);
    },
    diagnostics: () =>
      harden({
        getFormula: id =>
          harden({
            type: directories.has(id) ? 'directory' : 'make-unconfined',
          }),
      }),
  });
  return { host, root, directories, identify, writes };
};

test('whole installation migration retains nested records, owners and account identities', async t => {
  const f = fixture();
  const children = new Map([
    ['native-sandbox', 'native'],
    ['session-records', 'owner'],
    ['account-oracle', 'oracle'],
  ]);
  f.root.set('codex-sandbox', 'installation');
  f.directories.set('installation', children);
  await migrateBackendInstallation(f.host, 'codex-sandbox');
  t.false(f.root.has('codex-sandbox'));
  t.is(f.identify(...installationPath('codex-sandbox')), 'installation');
  for (const [name, identity] of children)
    t.is(f.identify(...installationPath('codex-sandbox', name)), identity);
  const writes = f.writes.length;
  await migrateBackendInstallation(f.host, 'codex-sandbox');
  await provideInstallationDirectory(f.host, 'codex-sandbox');
  t.is(f.writes.length, writes);
});

test('migration resumes a copied alias and refuses conflicting or non-directory roots', async t => {
  for (const conflict of [false, true]) {
    const f = fixture();
    await provideInstallationDirectory(f.host, 'claude-sandbox');
    const retained = f.identify(...installationPath('claude-sandbox'));
    f.root.set('claude-sandbox', conflict ? 'other-directory' : retained);
    if (conflict) f.directories.set('other-directory', new Map());
    if (conflict) {
      await t.throwsAsync(
        migrateBackendInstallation(f.host, 'claude-sandbox'),
        { message: /Conflicting/ },
      );
      t.true(f.root.has('claude-sandbox'));
    } else {
      await migrateBackendInstallation(f.host, 'claude-sandbox');
      t.false(f.root.has('claude-sandbox'));
    }
    t.is(f.identify(...installationPath('claude-sandbox')), retained);
  }
  const f = fixture();
  f.root.set('opencode-sandbox', 'impostor');
  await t.throwsAsync(migrateBackendInstallation(f.host, 'opencode-sandbox'), {
    message: /not a directory/,
  });
  t.is(f.writes.length, 0);
});

test('fresh setup has no ordinary root additions and bounded reruns', async t => {
  const f = fixture();
  for (const owner of ['claude-sandbox', 'codex-sandbox', 'opencode-sandbox']) {
    await migrateBackendInstallation(f.host, owner);
    await provideInstallationDirectory(f.host, owner);
  }
  const writes = f.writes.length;
  for (const owner of ['claude-sandbox', 'codex-sandbox', 'opencode-sandbox'])
    await provideInstallationDirectory(f.host, owner);
  t.deepEqual([...f.root.keys()], ['@pins']);
  t.is(f.writes.length, writes);
  t.deepEqual(installationPath('custom', 'backend'), ['custom', 'backend']);
});

test('staged aliases support old and early revived consumers before setup removes the old name', async t => {
  const f = fixture();
  f.root.set('codex-sandbox', 'installation');
  f.directories.set(
    'installation',
    new Map([
      ['session-records', 'owner'],
      ['broker-service', 'broker'],
      ['native-sandbox', 'native'],
    ]),
  );
  await migrateBackendInstallation(f.host, 'codex-sandbox', {
    removeLegacy: false,
  });
  for (const name of ['session-records', 'broker-service', 'native-sandbox']) {
    t.is(
      f.identify('codex-sandbox', name),
      f.identify(...installationPath('codex-sandbox', name)),
    );
  }
  const stagedWrites = f.writes.length;
  await migrateBackendInstallation(f.host, 'codex-sandbox', {
    removeLegacy: false,
  });
  t.is(f.writes.length, stagedWrites);
  await migrateBackendInstallation(f.host, 'codex-sandbox');
  t.false(f.root.has('codex-sandbox'));
  t.is(
    f.identify(...installationPath('codex-sandbox', 'session-records')),
    'owner',
  );
});
