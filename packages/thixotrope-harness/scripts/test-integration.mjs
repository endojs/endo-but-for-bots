#!/usr/bin/env node
// @ts-check
/**
 * Run integration files, each under its own run-lock slot and time box
 * (scripts/run-lock.mjs), several at once.
 *
 * One wrapper around the whole suite would put every file under one 10-minute
 * box, and the suite takes far longer than that run serially. Here each file
 * is its own `run-lock.mjs --label "integration <file>" -- ses-ava -- --serial
 * <file>` run: the box applies per file, every file has its own run-log line,
 * and up to `--jobs` files (default THIX_HARNESS_RUN_SLOTS, 4) run at once,
 * each in a slot of its own. A file's output is printed in one piece when it
 * ends; a summary of exit codes and times comes last.
 *
 * Usage:
 *   THIX_HARNESS_INTEGRATION=1 node scripts/test-integration.mjs
 *     [--jobs N] [--max-ms N] [file ...]
 *
 * With no files: every `*.test.js` under test/integration and test/template.
 * Run it through `corepack yarn test:integration`, which puts ses-ava on PATH.
 * Exit 0 when every file passed, 124 when one timed out and none failed
 * otherwise, else 1.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

import { TIMED_OUT_EXIT, slotsFromEnv } from './run-lock.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const runLockScript = path.join(here, 'run-lock.mjs');

const USAGE = 'Usage: test-integration.mjs [--jobs N] [--max-ms N] [file ...]';

/** @param {string[]} argv */
export const parseArgs = argv => {
  /** @type {{ jobs?: number, maxMs?: number, files: string[] }} */
  const options = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--jobs' || arg === '--max-ms') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1)
        throw Error(`${arg} takes a whole number >= 1\n${USAGE}`);
      if (arg === '--jobs') options.jobs = n;
      else options.maxMs = n;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw Error(`Unknown option ${arg}\n${USAGE}`);
    } else {
      options.files.push(arg);
    }
  }
  return options;
};

/** The default files, relative to the package. */
export const defaultFiles = async () => {
  const files = [];
  for (const dir of ['test/integration', 'test/template']) {
    const names = await readdir(path.join(packageRoot, dir)).catch(() => []);
    for (const name of names.sort())
      if (name.endsWith('.test.js')) files.push(`${dir}/${name}`);
  }
  return files;
};

/** @param {number} ms */
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * @param {string} file
 * @param {number | undefined} maxMs
 * @returns {Promise<{ file: string, code: number, ms: number, output: string }>}
 */
const runFile = (file, maxMs) =>
  new Promise(resolve => {
    const t0 = Date.now();
    const chunks = [];
    const child = spawn(
      process.execPath,
      [
        runLockScript,
        '--label',
        `integration ${path.basename(file)}`,
        ...(maxMs === undefined ? [] : ['--max-ms', String(maxMs)]),
        '--',
        'ses-ava',
        '--',
        '--serial',
        file,
      ],
      { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    const done = (/** @type {number} */ code) =>
      resolve({
        file,
        code,
        ms: Date.now() - t0,
        output: Buffer.concat(chunks).toString(),
      });
    child.once('error', error => {
      chunks.push(Buffer.from(`${error.message}\n`));
      done(127);
    });
    child.once('close', code => done(code ?? 1));
  });

/** @param {string[]} argv */
const main = async argv => {
  const options = parseArgs(argv);
  const files = options.files.length ? options.files : await defaultFiles();
  const jobs = Math.min(options.jobs ?? slotsFromEnv(), files.length);
  const t0 = Date.now();
  /** @type {Awaited<ReturnType<typeof runFile>>[]} */
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next];
      next += 1;
      const result = await runFile(file, options.maxMs);
      process.stdout.write(
        `\n===== ${result.file}: exit ${result.code} in ${seconds(result.ms)}\n${result.output}`,
      );
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  process.stdout.write(
    `\n===== integration: ${files.length} files, ${jobs} at once, ${seconds(Date.now() - t0)} wall\n`,
  );
  for (const r of results.sort((a, b) => a.file.localeCompare(b.file)))
    process.stdout.write(
      `${r.code === 0 ? 'ok  ' : 'FAIL'} ${String(r.code).padStart(3)} ${seconds(r.ms).padStart(8)}  ${r.file}\n`,
    );
  const failed = results.filter(r => r.code !== 0);
  if (failed.length === 0) process.exitCode = 0;
  else if (failed.every(r => r.code === TIMED_OUT_EXIT))
    process.exitCode = TIMED_OUT_EXIT;
  else process.exitCode = 1;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`test-integration: ${error.message}\n`);
    process.exitCode = 1;
  });
}
