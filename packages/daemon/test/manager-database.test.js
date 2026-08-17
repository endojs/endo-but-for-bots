// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));

test('database wrappers survive idle garbage collection', t => {
  const script = `
    await import('@endo/init');
    const { makeDaemonDatabase } = await import('./src/manager-database.js');
    let lastStatement;
    class FakeDatabase {
      constructor() {}
      pragma() {}
      exec() {}
      prepare() {
        lastStatement = {
          get: () => undefined,
          run: () => {},
          all: () => [],
        };
        return lastStatement;
      }
      close() {}
    }
    const config = {
      statePath: '',
      ephemeralStatePath: '',
      cachePath: '',
      sockPath: '',
    };
    const openAndDrop = () => {
      const database = makeDaemonDatabase(config, { Database: FakeDatabase });
      return {
        database: new WeakRef(database.db),
        statement: new WeakRef(lastStatement),
      };
    };
    const refs = openAndDrop();
    lastStatement = undefined;
    for (let i = 0; i < 20; i += 1) {
      Array.from({ length: 1000 }, () => ({}));
      globalThis.gc();
      await new Promise(resolve => setImmediate(resolve));
    }
    if (refs.database.deref() === undefined || refs.statement.deref() === undefined) {
      process.exit(1);
    }
  `;

  t.notThrows(() => {
    execFileSync(
      process.execPath,
      ['--expose-gc', '--input-type=module', '--eval', script],
      {
        cwd: packageDirectory,
        stdio: 'pipe',
      },
    );
  });
});
