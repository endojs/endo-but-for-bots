// @ts-check
// spell-out-exempt: `args` is the MCP config's stdio-server field name.
//
// Runs the CLI backend against a real child process: `fixtures/fake-claude.js`
// stands in for the pinned binary, so this needs no credential.

import test from '@endo/ses-ava/prepare-endo.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeClaudeCliBackend } from '../src/cli-backend.js';
import { makeNodeScratchDirectoryMaker } from '../src/scratch-directory.js';
import { makeCredentialSource, makeRequest } from './_backend-fixtures.js';

/** @import { ExecutionContext } from 'ava' */

const fakeClaude = fileURLToPath(
  new URL('fixtures/fake-claude.js', import.meta.url),
);

/**
 * @param {ExecutionContext} t
 */
const makeBackend = async t => {
  // Resolve symlinks (macOS `/tmp` is `/private/tmp`) so the paths the backend
  // hands the child match the `process.cwd()` it reports.
  const parentDirectory = await realpath(
    await mkdtemp(join(tmpdir(), 'endo-claude-process-')),
  );
  t.teardown(() => rm(parentDirectory, { recursive: true, force: true }));
  const source = makeCredentialSource();
  const backend = makeClaudeCliBackend({
    credentialSource: source.credentialSource,
    executablePath: fakeClaude,
    version: 'fake',
    stdioProjection: () => harden({ command: '/opt/endo/bin/relay' }),
    spawn: /** @type {any} */ (spawn),
    makeScratchDirectory: makeNodeScratchDirectoryMaker({ parentDirectory }),
    kill: process.kill.bind(process),
    timers: harden({
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: handle => clearTimeout(handle),
    }),
    pathValue: dirname(process.execPath),
  });
  return { backend, source, parentDirectory };
};

test('a real process sees only the constructed environment and its prompt', async t => {
  const { backend, source, parentDirectory } = await makeBackend(t);
  const result = await backend.infer(makeRequest());
  if (result.type !== 'ok') {
    t.fail(JSON.stringify(result));
    return;
  }
  const report = JSON.parse(result.text);
  t.is(report.prompt, 'write then read');
  t.is(report.home, join(report.cwd, 'config'));
  // Node's spawn itself adds NODE_V8_COVERAGE under a coverage run.
  const environmentKeys = report.environmentKeys.filter(
    key => key !== 'NODE_V8_COVERAGE',
  );
  t.deepEqual(environmentKeys, [
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CONFIG_DIR',
    'DISABLE_AUTOUPDATER',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'TMPDIR',
  ]);
  t.deepEqual(report.mcpConfig, {
    mcpServers: {
      endo: { type: 'stdio', command: '/opt/endo/bin/relay', args: [] },
    },
  });
  t.true(report.argv.includes('--bare'));
  t.deepEqual(source.counts, { acquired: 1, released: 1 });
  t.deepEqual(await readdir(parentDirectory), [], 'the scratch is removed');
});

test('the wall clock kills a real process group', async t => {
  const { backend, source } = await makeBackend(t);
  const started = Date.now();
  const result = await backend.infer(
    harden({
      ...makeRequest(),
      prompt: 'hang',
      limits: { maxWallClockMs: 500, maxOutputBytes: 10_000, maxTurns: 2 },
    }),
  );
  t.deepEqual(result, { type: 'limit-exceeded', which: 'wall-clock' });
  t.true(Date.now() - started < 10_000);
  t.is(source.counts.released, 1);
});
