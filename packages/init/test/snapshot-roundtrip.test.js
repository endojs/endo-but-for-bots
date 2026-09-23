import test from 'ava';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const avaCli = fileURLToPath(new URL('cli.js', import.meta.resolve('ava')));

const runAva = (snapshotDir, ...args) =>
  spawnSync(
    process.execPath,
    [avaCli, '--config', 'test/_snapshot-roundtrip/ava.config.js', ...args],
    {
      cwd: packageDir,
      env: { ...process.env, ENDO_SNAPSHOT_ROUNDTRIP_DIR: snapshotDir },
      encoding: 'utf-8',
    },
  );

test('ava snapshots written under @endo/init read back', t => {
  const snapshotDir = mkdtempSync(join(tmpdir(), 'endo-snapshot-roundtrip-'));
  t.teardown(() => rmSync(snapshotDir, { recursive: true, force: true }));

  const write = runAva(snapshotDir, '--update-snapshots');
  t.is(write.status, 0, `${write.stdout}\n${write.stderr}`);
  t.true(readdirSync(snapshotDir, { recursive: true }).some(name => String(name).endsWith('.snap')));

  const read = runAva(snapshotDir);
  t.is(read.status, 0, `${read.stdout}\n${read.stderr}`);
});
