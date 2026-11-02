// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INNER_PATH_PATTERN } from '@endo/sandbox/policy.js';

import {
  makeSessionStateStorage,
  makeStateStorageOperations,
} from '../src/session-state-storage.js';

/** @param {import('ava').ExecutionContext} t */
const makeRoot = async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'session-state-'));
  t.teardown(() => rm(base, { recursive: true, force: true }));
  return path.join(await realpath(base), 'state');
};

const exists = async p =>
  lstat(p).then(
    () => true,
    () => false,
  );

test('preparation creates a private session directory owned through a marker beside it', async t => {
  const root = await makeRoot(t);
  const storage = makeSessionStateStorage({ stateRoot: root });
  const { directory } = await storage.prepareSessionDirectory('session-a');
  t.is(path.dirname(path.dirname(directory)), `${root}/native_allocations`);
  t.is(path.basename(directory), 'data');
  t.true(
    INNER_PATH_PATTERN.test(directory),
    'actual allocated source satisfies the runtime mount-source guard',
  );
  t.true(
    INNER_PATH_PATTERN.test(path.dirname(directory)),
    'native bind root satisfies the same runtime guard',
  );
  // eslint-disable-next-line no-bitwise
  t.is((await stat(directory)).mode & 0o777, 0o700);
  const record = JSON.parse(
    await readFile(`${root}/.owners/session-a`, 'utf8'),
  );
  t.is(record.sessionId, 'session-a');
  t.is(record.dataIno, String((await lstat(directory, { bigint: true })).ino));
  // Reopening is idempotent and returns the same placement.
  t.deepEqual(await storage.prepareSessionDirectory('session-a'), {
    directory,
  });
  await t.throwsAsync(storage.prepareSessionDirectory('../escape'), {
    message: /Invalid session id/,
  });
});

test('a directory owned by another session is refused, not reused or removed', async t => {
  const root = await makeRoot(t);
  const storage = makeSessionStateStorage({ stateRoot: root });
  const { directory } = await storage.prepareSessionDirectory('session-a');
  await writeFile(`${root}/.owners/session-a`, 'someone-else\n');
  await t.throwsAsync(storage.prepareSessionDirectory('session-a'), {
    message: /not owned by this session/,
  });
  await t.throwsAsync(storage.removeSessionDirectory('session-a'), {
    message: /not owned by this session/,
  });
  t.true(await exists(directory));
});

test('removal deletes only the owned directory and its marker, and tolerates absence', async t => {
  const root = await makeRoot(t);
  const storage = makeSessionStateStorage({ stateRoot: root });
  const { directory } = await storage.prepareSessionDirectory('session-a');
  await writeFile(path.join(directory, 'db.sqlite'), 'x');
  const sibling = await storage.prepareSessionDirectory('session-b');
  await storage.removeSessionDirectory('session-a');
  t.false(await exists(directory));
  t.false(await exists(`${root}/.owners/session-a`));
  t.true(await exists(sibling.directory));
  await storage.removeSessionDirectory('session-a');
  await storage.removeSessionDirectory('never-prepared');
  t.pass('absent directories are already removed');
});

test('symbolic links at the root, the owners directory, or a session path are refused', async t => {
  const base = await makeRoot(t);
  const target = path.join(path.dirname(base), 'elsewhere');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await symlink(target, base);
  const linkedRoot = makeSessionStateStorage({ stateRoot: base });
  await t.throwsAsync(linkedRoot.prepareSessionDirectory('session-a'), {
    message: /State root must not be a symlink/,
  });
  t.is(await readlink(base), target, 'the link is untouched');
  const root = path.join(path.dirname(base), 'real-state');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await symlink(target, path.join(root, '.owners'));
  const linkedOwners = makeSessionStateStorage({ stateRoot: root });
  await t.throwsAsync(linkedOwners.prepareSessionDirectory('session-a'), {
    message: /Ownership directory must not be a symlink/,
  });
  // A session path that became a symlink is neither reused nor removed.
  const other = path.join(path.dirname(base), 'other-state');
  const storage = makeSessionStateStorage({ stateRoot: other });
  const { directory } = await storage.prepareSessionDirectory('session-a');
  await rm(directory, { recursive: true });
  await symlink(target, directory);
  await t.throwsAsync(storage.prepareSessionDirectory('session-a'), {
    message: /symbolic link|Cannot create session state directory/,
  });
  await t.throwsAsync(storage.removeSessionDirectory('session-a'), {
    message: /symbolic link/,
  });
  t.is(await readlink(directory), target, 'untouched');
});

for (const stage of [
  'directory-created',
  'record-opened',
  'record-written',
  'record-published',
]) {
  test(`reconstruction recovers a crash at ${stage} without adopting ambiguous state`, async t => {
    const root = await makeRoot(t);
    const failure = Error('Simulated process loss');
    const broken = makeStateStorageOperations(root, {
      checkpoint: async point => {
        if (point === stage) throw failure;
      },
    });
    await t.throwsAsync(broken.prepareSessionDirectory('session-a'), {
      is: failure,
    });
    // New object, no retained maps or failure cleanup; only disk state survives.
    const restored = makeStateStorageOperations(root);
    const before = await restored.inspectAllocations();
    t.is(before.length, 1);
    t.is(
      before[0].state,
      stage === 'directory-created' || stage === 'record-opened'
        ? 'unproven'
        : stage === 'record-written'
          ? 'unreferenced'
          : 'published',
    );
    const { directory } = await restored.prepareSessionDirectory('session-a');
    t.true(await exists(directory));
    const after = await restored.inspectAllocations();
    t.is(after.length, stage === 'record-published' ? 1 : 2);
    if (stage === 'record-written') {
      await restored.removeUnreferencedAllocation(before[0].allocation);
      t.is((await restored.inspectAllocations()).length, 1);
    } else {
      await t.throwsAsync(
        restored.removeUnreferencedAllocation(before[0].allocation),
        { message: /published|unproven/ },
      );
    }
    t.deepEqual(
      await makeStateStorageOperations(root).prepareSessionDirectory(
        'session-a',
      ),
      { directory },
    );
  });
}

test('foreign fixed directory arriving during preparation is never adopted on retry', async t => {
  const root = await makeRoot(t);
  const broken = makeStateStorageOperations(root, {
    checkpoint: async stage => {
      if (stage === 'record-written') {
        await mkdir(`${root}/session-a`);
        await writeFile(`${root}/session-a/foreign`, 'keep');
      }
    },
  });
  await t.throwsAsync(broken.prepareSessionDirectory('session-a'), {
    message: /not owned/,
  });
  const restored = makeStateStorageOperations(root);
  await t.throwsAsync(restored.prepareSessionDirectory('session-a'), {
    message: /not owned/,
  });
  await t.throwsAsync(restored.removeSessionDirectory('session-a'), {
    message: /not owned/,
  });
  t.is(await readFile(`${root}/session-a/foreign`, 'utf8'), 'keep');
});

test('directory substitution is refused and delete/recreate selects a fresh allocation', async t => {
  const root = await makeRoot(t);
  const storage = makeStateStorageOperations(root);
  const first = await storage.prepareSessionDirectory('session-a');
  await storage.removeSessionDirectory('session-a');
  const second = await storage.prepareSessionDirectory('session-a');
  t.not(first.directory, second.directory);
  // Keep the original inode alive so the filesystem cannot reuse it.
  const old = `${second.directory}-old`;
  await rename(second.directory, old);
  await mkdir(second.directory);
  await writeFile(`${second.directory}/foreign`, 'keep');
  await t.throwsAsync(storage.prepareSessionDirectory('session-a'), {
    message: /not owned/,
  });
  await t.throwsAsync(storage.removeSessionDirectory('session-a'), {
    message: /not owned/,
  });
  t.is(await readFile(`${second.directory}/foreign`, 'utf8'), 'keep');
});

test('publication cannot replace a foreign ownership record', async t => {
  const root = await makeRoot(t);
  const storage = makeStateStorageOperations(root, {
    checkpoint: async stage => {
      if (stage === 'record-written')
        await writeFile(`${root}/.owners/session-a`, 'foreign');
    },
  });
  await t.throwsAsync(storage.prepareSessionDirectory('session-a'), {
    code: 'EEXIST',
  });
  t.is(await readFile(`${root}/.owners/session-a`, 'utf8'), 'foreign');
  await t.throwsAsync(
    makeStateStorageOperations(root).prepareSessionDirectory('session-a'),
    { message: /not owned/ },
  );
});

test('removal resumes after allocation deletion without reusing its old directory', async t => {
  const root = await makeRoot(t);
  const original =
    await makeStateStorageOperations(root).prepareSessionDirectory('session-a');
  const storage = makeStateStorageOperations(root, {
    checkpoint: async stage => {
      if (stage === 'allocation-removed') throw Error('Process loss');
    },
  });
  await t.throwsAsync(storage.removeSessionDirectory('session-a'), {
    message: 'Process loss',
  });
  const restored = makeStateStorageOperations(root);
  await t.throwsAsync(restored.prepareSessionDirectory('session-a'), {
    message: /Published.*missing/,
  });
  await restored.removeSessionDirectory('session-a');
  const replacement = await restored.prepareSessionDirectory('session-a');
  t.not(replacement.directory, original.directory);
  t.false(await exists(original.directory));
});

test('orphan inventory preserves incomplete and symlinked allocations', async t => {
  const root = await makeRoot(t);
  const storage = makeStateStorageOperations(root);
  const prepared = await storage.prepareSessionDirectory('session-a');
  const unknown = `${root}/native_allocations/unknown-X`;
  await mkdir(unknown);
  await writeFile(`${unknown}/foreign`, 'keep');
  await symlink(
    path.dirname(prepared.directory),
    `${root}/native_allocations/linked-X`,
  );
  const inventory = await storage.inspectAllocations();
  for (const allocation of ['unknown-X', 'linked-X']) {
    t.like(
      inventory.find(entry => entry.allocation === allocation),
      { state: 'unproven' },
    );
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(storage.removeUnreferencedAllocation(allocation), {
      message: /unproven/,
    });
  }
  t.is(await readFile(`${unknown}/foreign`, 'utf8'), 'keep');
});

test('a retry flushes publication after link succeeded but directory sync failed', async t => {
  const root = await makeRoot(t);
  const interrupted = makeStateStorageOperations(root, {
    syncDirectory: async directory => {
      if (directory === `${root}/.owners`) throw Error('Sync failed');
    },
  });
  await t.throwsAsync(interrupted.prepareSessionDirectory('session-a'), {
    message: 'Sync failed',
  });
  const flushes = [];
  const recovered = makeStateStorageOperations(root, {
    syncDirectory: async directory => {
      flushes.push(directory);
    },
  });
  await recovered.prepareSessionDirectory('session-a');
  t.true(flushes.includes(`${root}/.owners`));
  t.true(
    flushes.includes(path.dirname(root)),
    'creation of the root is flushed through its parent',
  );
  t.true(
    flushes.includes(path.parse(root).root),
    'recursive parent creation is covered through the root',
  );
});

test('a retry flushes session deletion after marker unlink succeeded', async t => {
  const root = await makeRoot(t);
  await makeStateStorageOperations(root).prepareSessionDirectory('session-a');
  const interrupted = makeStateStorageOperations(root, {
    syncDirectory: async directory => {
      if (directory === `${root}/.owners`) throw Error('Sync failed');
    },
  });
  await t.throwsAsync(interrupted.removeSessionDirectory('session-a'), {
    message: 'Sync failed',
  });
  t.false(await exists(`${root}/.owners/session-a`));
  const flushes = [];
  await makeStateStorageOperations(root, {
    syncDirectory: async directory => {
      flushes.push(directory);
    },
  }).removeSessionDirectory('session-a');
  t.true(flushes.includes(`${root}/.owners`));
});

test('orphan removal retains external proof after recursive deletion removes its internal record', async t => {
  const root = await makeRoot(t);
  const interrupted = makeStateStorageOperations(root, {
    checkpoint: async stage => {
      if (stage === 'record-written') throw Error('Process loss');
    },
  });
  await t.throwsAsync(interrupted.prepareSessionDirectory('session-a'), {
    message: 'Process loss',
  });
  const [{ allocation }] =
    await makeStateStorageOperations(root).inspectAllocations();
  const failedRemoval = makeStateStorageOperations(root, {
    removeDirectory: async directory => {
      await rm(`${directory}/record`);
      throw Error('Removal failed');
    },
  });
  await t.throwsAsync(failedRemoval.removeUnreferencedAllocation(allocation), {
    message: 'Removal failed',
  });
  const recovered = makeStateStorageOperations(root);
  t.deepEqual(await recovered.inspectAllocations(), [
    { allocation, state: 'retiring' },
  ]);
  const data = `${root}/native_allocations/${allocation}/data`;
  await rename(data, `${data}-original`);
  await mkdir(data);
  await writeFile(`${data}/foreign`, 'keep');
  await t.throwsAsync(recovered.removeUnreferencedAllocation(allocation), {
    message: /unproven/,
  });
  t.is(await readFile(`${data}/foreign`, 'utf8'), 'keep');
  // Restore the original inode; the test's substitute is not production data.
  await rm(data, { recursive: true });
  await rename(`${data}-original`, data);
  await recovered.removeUnreferencedAllocation(allocation);
  t.deepEqual(await recovered.inspectAllocations(), []);
  await recovered.removeUnreferencedAllocation(allocation);
});

test('a retry flushes orphan retirement after its intent unlink succeeded', async t => {
  const root = await makeRoot(t);
  const interrupted = makeStateStorageOperations(root, {
    checkpoint: async stage => {
      if (stage === 'record-written') throw Error('Process loss');
    },
  });
  await t.throwsAsync(interrupted.prepareSessionDirectory('session-a'), {
    message: 'Process loss',
  });
  const [{ allocation }] =
    await makeStateStorageOperations(root).inspectAllocations();
  let retirementFlushes = 0;
  const failed = makeStateStorageOperations(root, {
    syncDirectory: async directory => {
      if (directory === `${root}/.retirements`) {
        retirementFlushes += 1;
        if (retirementFlushes === 2) throw Error('Sync failed');
      }
    },
  });
  await t.throwsAsync(failed.removeUnreferencedAllocation(allocation), {
    message: 'Sync failed',
  });
  const flushes = [];
  await makeStateStorageOperations(root, {
    syncDirectory: async directory => {
      flushes.push(directory);
    },
  }).removeUnreferencedAllocation(allocation);
  t.true(flushes.includes(`${root}/.retirements`));
});
