// @ts-check
import test from '@endo/ses-ava/test.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeNodePowers } from '../src/platform/node/powers.js';

/** @import { ExecutionContext } from 'ava' */

const available = isBuiltin('node:sqlite');
const sqliteModule = await (available
  ? import('../scripts/mail-hub-sqlite.mjs')
  : undefined);
const makeBackend = sqliteModule?.makeMailHubSqlite;
const sqliteTest = available ? test.serial : test.serial.skip;
const files = makeNodePowers().syncFiles;

/** @param {ExecutionContext} t */
const fixture = async t => {
  const root = await mkdtemp('/tmp/thix-hub-sqlite-');
  const backends = [];
  t.teardown(async () => {
    for (const backend of backends) backend.close();
    await rm(root, { recursive: true, force: true });
  });
  const open = () => {
    if (makeBackend === undefined) throw Error('node:sqlite is unavailable');
    const backend = makeBackend(files);
    backends.push(backend);
    return backend;
  };
  return { root, path: join(root, 'hub.json'), open };
};

sqliteTest(
  'experimental SQLite hub snapshots reopen without changing legacy JSON',
  async t => {
    const f = await fixture(t);
    files.writeTextAtomic(f.path, '{"sequence":0}\n');
    const backend = f.open();
    t.is(JSON.parse(backend.syncFiles.readText(f.path)).sequence, 0);
    for (const sequence of [1, 2, 3]) {
      backend.syncFiles.writeTextAtomic(
        f.path,
        `${JSON.stringify({ sequence })}\n`,
      );
    }
    backend.close();
    t.is(JSON.parse(f.open().syncFiles.readText(f.path)).sequence, 3);
    t.is(
      JSON.parse(files.readText(f.path)).sequence,
      0,
      'incompatible experiment leaves legacy file stale',
    );
  },
);

sqliteTest(
  'invalid SQLite snapshot input preserves the last committed row',
  async t => {
    const f = await fixture(t);
    const backend = f.open();
    backend.syncFiles.writeTextAtomic(f.path, '{"sequence":1}\n');
    t.throws(() => backend.syncFiles.writeTextAtomic(f.path, '{broken'), {
      instanceOf: SyntaxError,
    });
    t.is(JSON.parse(backend.syncFiles.readText(f.path)).sequence, 1);
    backend.close();
    t.throws(() => backend.syncFiles.writeTextAtomic(f.path, '{}\n'), {
      message: /closed/,
    });
  },
);

sqliteTest(
  'SQLite refuses corrupted experiment state instead of falling back to stale JSON',
  async t => {
    const f = await fixture(t);
    files.writeTextAtomic(f.path, '{"sequence":0}\n');
    await writeFile(`${f.path}.experiment.sqlite`, 'not a database');
    t.throws(() => f.open().syncFiles.readText(f.path), {
      message: /not a database/,
    });
  },
);

sqliteTest(
  'committed SQLite hub state survives SIGKILL with an uncheckpointed WAL',
  async t => {
    t.timeout(10_000);
    const f = await fixture(t);
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/mail-hub-sqlite-child.mjs', import.meta.url),
      ),
      [f.path],
      {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const exited = once(child, 'exit');
    t.teardown(async () => {
      child.kill('SIGKILL');
      await exited;
    });
    const [message] = await Promise.race([
      once(child, 'message'),
      exited.then(() => {
        throw Error('SQLite fixture exited before commit');
      }),
    ]);
    t.deepEqual(message, { committed: true });
    t.true(files.exists(`${f.path}.experiment.sqlite-wal`));
    child.kill('SIGKILL');
    t.deepEqual(await exited, [null, 'SIGKILL']);
    t.is(JSON.parse(f.open().syncFiles.readText(f.path)).sequence, 42);
  },
);
