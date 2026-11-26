// @ts-check
// The shell's refusal of a Node too old for it, through the check it runs at
// startup, given fabricated versions rather than another installed Node.
import test from '@endo/ses-ava/test.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  MIN_NODE_VERSION,
  nodeVersionProblem,
} from '../../src/ironhorse/wasm/shell.mjs';
import { WASM_WORKER, tempDir } from './_shell-harness.js';

test('the minimum is a plain version', t => {
  t.regex(MIN_NODE_VERSION, /^\d+\.\d+\.\d+$/);
  t.is(nodeVersionProblem(process.version), undefined, 'this Node runs it');
});

test('older versions are refused with the minimum named', t => {
  for (const version of [
    'v22.15.1',
    'v22.13.0',
    'v22.5.0',
    'v21.7.3',
    'v20.18.0',
    'v18.20.4',
    'v0.12.18',
  ]) {
    t.regex(
      nodeVersionProblem(version) ?? '',
      new RegExp(
        `^Node ${version.replace(/\./g, '\\.')} is too old for the wasm Ironhorse worker, which needs Node 22\\.16\\.0 or later`,
      ),
      version,
    );
  }
});

test('the minimum and later versions pass', t => {
  for (const version of [
    'v22.16.0',
    'v22.16.1',
    'v22.23.5',
    'v23.0.0',
    'v24.0.0',
    'v24.22.3',
    'v100.0.0',
    '22.16.0',
  ]) {
    t.is(nodeVersionProblem(version), undefined, version);
  }
});

test('an unrecognized version is refused', t => {
  t.is(nodeVersionProblem('vNext'), 'unrecognized Node version "vNext"');
});

test('the shell reports a refusal as a failed worker', async t => {
  // The check runs before anything else, so a fabricated old version
  // installed over `process.version` refuses before the lease is checked.
  const dir = await tempDir(t);
  const shell = join(WASM_WORKER, '..', 'thixotrope-ironhorse-wasm-shell.mjs');
  const script = `Object.defineProperty(process, 'version', { value: 'v22.15.1' }); const { main } = await import(${JSON.stringify(shell)}); process.exitCode = await main(['--lease-fd=99', ${JSON.stringify(join(dir, 'heap.sqlite'))}, 'p', 'l', '{}']);`;
  const error = await t.throwsAsync(
    promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ]),
  );
  const failure =
    /** @type {{ code: number, stdout: string, stderr: string }} */ (
      /** @type {unknown} */ (error)
    );
  t.is(failure.code, 1);
  t.is(failure.stdout, '');
  t.regex(
    failure.stderr,
    /^worker failed: Node v22\.15\.1 is too old for the wasm Ironhorse worker, which needs Node 22\.16\.0 or later/,
  );
});
