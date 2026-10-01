#!/usr/bin/env node
// @ts-check
/* global process */
// Run one confined `claude -p` turn against one guest's tools.
//
//   endo-claude-turn --formula-id <64-hex> --model <model> \
//     --claude <absolute path> --credential-file <path> \
//     [--pinned-cli-version <version>] [--bwrap <absolute path>] < prompt
//
// The credential is read from a file, never from argv or the environment; the
// prompt is read from stdin. With `--bwrap`, `claude` runs inside the bwrap
// slice. The tagged result is written to stdout as JSON.
import '@endo/init';

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { runConfinedTurn } from '../src/confined-turn.js';

const { values } = parseArgs({
  options: {
    'formula-id': { type: 'string' },
    model: { type: 'string' },
    claude: { type: 'string' },
    'credential-file': { type: 'string' },
    'pinned-cli-version': { type: 'string' },
    bwrap: { type: 'string' },
  },
  strict: true,
});

const required = ['formula-id', 'model', 'claude', 'credential-file'];
const missing = required.filter(name => values[name] === undefined);
if (missing.length > 0) {
  process.stderr.write(`endo-claude-turn: missing --${missing.join(', --')}\n`);
  process.exit(2);
}

const credential = fs
  .readFileSync(/** @type {string} */ (values['credential-file']), 'utf-8')
  .trim();
const prompt = fs.readFileSync(0, 'utf-8');

runConfinedTurn({
  formulaId: /** @type {string} */ (values['formula-id']),
  model: /** @type {string} */ (values.model),
  claudePath: /** @type {string} */ (values.claude),
  credential,
  prompt,
  ...(values['pinned-cli-version'] === undefined
    ? {}
    : { pinnedCliVersion: values['pinned-cli-version'] }),
  ...(values.bwrap === undefined
    ? {}
    : { sandbox: { bwrapPath: values.bwrap } }),
}).then(
  result => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () =>
      process.exit(result.type === 'ok' ? 0 : 1),
    );
  },
  error => {
    process.stderr.write(`endo-claude-turn: ${error?.message ?? error}\n`, () =>
      process.exit(2),
    );
  },
);
