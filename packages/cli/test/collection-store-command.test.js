// @ts-nocheck

import '@endo/init';

import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import test from 'ava';
import url from 'url';
import { $ } from 'execa';

const dirname = url.fileURLToPath(new URL('.', import.meta.url)).toString();
const testRoot = path.join(dirname, 'tmp', 'collection-store-command');
const environment = {
  TMPDIR: '/tmp',
  XDG_STATE_HOME: path.join(testRoot, 'state'),
  XDG_RUNTIME_DIR: path.join(testRoot, 'run'),
  XDG_CACHE_HOME: path.join(testRoot, 'cache'),
  ENDO_SOCK: `/tmp/endo-cli-store-${process.pid}.sock`,
  ENDO_ADDR: '127.0.0.1:0',
};

test.serial('CLI creates and operates on named map and set stores', async t => {
  const execa = $({ cwd: dirname, env: environment });
  await execa`endo purge -f`;
  await execa`endo start`;
  try {
    await execa`endo mkmap inventory`;
    await execa`endo map inventory init ${'"apples"'} 2 --json`;
    await execa`endo map inventory set ${'"apples"'} 3 --json`;
    t.is(
      (await execa`endo map inventory get ${'"apples"'} --json`).stdout,
      '3',
    );
    t.is((await execa`endo map inventory has apples`).stdout, 'true');
    t.is((await execa`endo map inventory entries`).stdout, '[["apples",3]]');

    await execa`endo mkset colors`;
    await execa`endo set colors add blue`;
    await execa`endo set colors add red`;
    t.is((await execa`endo set colors size`).stdout, '2');
    t.is(
      (await execa`endo set colors entries`).stdout,
      '[["blue","blue"],["red","red"]]',
    );

    const setFormula = JSON.parse(
      (await execa`endo inspect colors --json`).stdout,
    );
    const database = new DatabaseSync(
      path.join(testRoot, 'state', 'endo', 'endo.sqlite'),
    );
    const rows = database
      .prepare(
        'SELECT value_body AS valueBody, value_slots AS valueSlots FROM collection_store_entry WHERE store_number = ?',
      )
      .all(setFormula.number);
    database.close();
    t.is(rows.length, 2);
    for (const row of rows) {
      t.is(row.valueBody, null);
      t.is(row.valueSlots, null);
    }

    await execa`endo restart`;
    t.is((await execa`endo map inventory get apples`).stdout, '3');
    t.is((await execa`endo set colors has blue`).stdout, 'true');

    await execa`endo set colors snapshot --name color-snapshot`;
    const snapshotOutput = (await execa`endo show color-snapshot`).stdout;
    t.regex(snapshotOutput, /payload/);
    t.regex(snapshotOutput, /blue/);
    t.regex(snapshotOutput, /red/);
  } finally {
    await execa`endo purge -f`;
  }
});

test('CLI help exposes coherent map and set command shapes', async t => {
  const execa = $({ cwd: dirname });
  const results = await Promise.all(
    ['map', 'set'].map(async kind => {
      await null;
      return {
        kind,
        stdout: (await execa`endo ${kind} --help`).stdout,
      };
    }),
  );
  for (const { kind, stdout } of results) {
    t.regex(stdout, new RegExp(`Usage: endo ${kind} .*<name> <verb>`));
    t.regex(stdout, /--json/);
    t.regex(stdout, /--name/);
  }
});
