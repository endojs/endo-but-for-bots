// @ts-check
/* eslint-disable @jessie.js/safe-await-separator */

import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
/**
 * @type {{
 *   default: typeof import('tsd').default;
 *   formatter: typeof import('tsd').formatter;
 * }}
 */
const tsdModule = require('tsd');

const { default: runTsd, formatter } = tsdModule;

const usage = `Usage: node scripts/run-tsd.mjs --typings <file> --files <glob> [--files <glob> ...]

Run this command from a workspace package after the repository composite
declaration build has completed.`;

/** @type {string | undefined} */
let typingsFile;
/** @type {string[]} */
const testFiles = [];
const args = process.argv.slice(2);

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const value = args[index + 1];
  if (argument === '--typings' && value) {
    typingsFile = value;
    index += 1;
  } else if (argument === '--files' && value) {
    testFiles.push(value);
    index += 1;
  } else {
    console.error(usage);
    process.exitCode = 2;
    break;
  }
}

if (
  process.exitCode === undefined &&
  (!typingsFile || testFiles.length === 0)
) {
  console.error(usage);
  process.exitCode = 2;
}

if (process.exitCode === undefined && typingsFile) {
  const cwd = process.cwd();
  try {
    await access(path.resolve(cwd, typingsFile));
  } catch {
    console.error(
      `Missing declaration entry ${typingsFile}; run yarn build:types from the repository root first.`,
    );
    process.exitCode = 1;
  }

  if (process.exitCode === undefined) {
    const diagnostics = await runTsd({ cwd, typingsFile, testFiles });
    if (diagnostics.length > 0) {
      const output = formatter(diagnostics, true);
      console.error(output);
      if (diagnostics.some(({ severity }) => severity === 'error')) {
        process.exitCode = 1;
      }
    }
  }
}
