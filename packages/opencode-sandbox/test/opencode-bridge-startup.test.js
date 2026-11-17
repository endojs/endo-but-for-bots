// @ts-check
import '@endo/init';
import test from 'ava';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const bridgePath = fileURLToPath(
  new URL('../src/opencode-bridge.mjs', import.meta.url),
);
const serverPath = fileURLToPath(
  new URL('./fixtures/fake-opencode-server.mjs', import.meta.url),
);

for (const mode of [
  'stale-file',
  'non-directory',
  'create-failure',
  'null',
  'empty-id',
]) {
  test.serial(`bridge startup uses fresh native history: ${mode}`, async t => {
    t.timeout(15_000);
    const directory = await mkdtemp(
      path.join(tmpdir(), 'endo-bridge-startup-'),
    );
    t.teardown(() => rm(directory, { recursive: true, force: true }));
    const marker = path.join(directory, 'opencode-session-id');
    await writeFile(marker, 'ses_retired\n');
    const child = spawn(process.execPath, [bridgePath], {
      env: {
        PATH: process.env.PATH,
        OPENCODE_BIN: serverPath,
        OPENCODE_SESSION_ID: 'ses_retired',
        XDG_DATA_HOME: mode === 'non-directory' ? marker : directory,
        FAKE_CREATE_FAILURE: mode === 'create-failure' ? '1' : '0',
        FAKE_CREATE_INVALID: mode,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.teardown(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
        const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
    });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    t.teardown(() => lines.close());
    let startup;
    for await (const line of lines) {
      const event = JSON.parse(line);
      if (event.type === 'ready' || event.type === 'abort') {
        startup = event;
        break;
      }
    }
    t.truthy(startup);
    if (['create-failure', 'null', 'empty-id'].includes(mode)) {
      t.is(startup.type, 'abort');
      t.regex(startup.reason, /could not create a session/);
      t.is((await exited)[0], 1);
    } else {
      t.is(startup.type, 'ready');
      t.is(startup.sessionId, 'ses_fresh');
      t.deepEqual(startup.features, ['import', 'fresh-session']);
      child.stdin.end(`${JSON.stringify({ op: 'shutdown' })}\n`);
      t.is((await exited)[0], 0);
    }
    t.is(await readFile(marker, 'utf8'), 'ses_retired\n');
  });
}
