// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/endo-mcp-stdio.js', import.meta.url));

/**
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
const run = env =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });

/** @param {string} stderr */
const lastRecord = stderr =>
  JSON.parse(
    stderr
      .trim()
      .split('\n')
      .filter(line => line.startsWith('{'))
      .at(-1) ?? '{}',
  );

test('the bin refuses to construct without a formula id', async t => {
  const { code, stdout, stderr } = await run({});
  t.is(code, 1);
  t.is(stdout, '');
  t.is(lastRecord(stderr).reason, 'invalid-formula-id');
});

test('the bin reports an unreachable daemon', async t => {
  const { code, stdout, stderr } = await run({
    ENDO_GUEST_FORMULA_ID: 'ab'.repeat(32),
    ENDO_SOCK: '/nonexistent/endo-mcp-stdio-test.sock',
  });
  t.is(code, 1);
  t.is(stdout, '');
  t.is(lastRecord(stderr).reason, 'daemon-unreachable');
});
