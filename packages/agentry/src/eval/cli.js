#!/usr/bin/env node
// @ts-check
/// <reference types="ses"/>

/* global process */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  defaultEvalConditions,
  evalConditionsByName,
} from './conditions/index.js';
import { resolveEvalModelsFromEnv } from './env-model.js';
import { renderEvalMatrixMarkdownTable, runEvalMatrix } from './matrix.js';
import { readText } from './repo.js';
import { makeDefaultGitScenarioSpecs } from './scenarios/index.js';

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
const splitCsv = value =>
  (value || '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);

/**
 * @param {string[]} argv
 * @returns {{ models?: string, repeats: number, conditions?: string, out?: string }}
 */
const parseArgs = argv => {
  /** @type {{ models?: string, repeats: number, conditions?: string, out?: string }} */
  const args = { repeats: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === '--models') {
      args.models = readValue();
    } else if (arg === '--repeats') {
      args.repeats = Number(readValue());
    } else if (arg === '--conditions') {
      args.conditions = readValue();
    } else if (arg === '--out') {
      args.out = readValue();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 1) {
    throw new Error('--repeats must be a positive integer');
  }
  return harden(args);
};

/**
 * @param {string | undefined} names
 */
const selectConditions = names => {
  const requested = splitCsv(names);
  if (requested.length === 0) {
    return defaultEvalConditions;
  }
  return harden(
    requested.map(name => {
      if (!Object.hasOwn(evalConditionsByName, name)) {
        throw new Error(`unknown eval condition: ${name}`);
      }
      return evalConditionsByName[name];
    }),
  );
};

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * @param {string[]} argv
 */
export const main = async argv => {
  const args = parseArgs(argv);
  const env = /** @type {Record<string, string | undefined>} */ (process.env);
  const models = resolveEvalModelsFromEnv(env, { models: args.models });
  if (models.length === 0) {
    throw new Error(
      'no eval models configured; set ENDO_EVAL_MODELS or pass --models',
    );
  }
  const result = await runEvalMatrix({
    scenarios: makeDefaultGitScenarioSpecs(),
    conditions: selectConditions(args.conditions),
    models,
    repeats: args.repeats,
    readText,
  });
  const table = renderEvalMatrixMarkdownTable(result.aggregates);
  const outPath =
    args.out ||
    path.join(process.cwd(), `agentry-eval-matrix-${timestamp()}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(table.trimEnd());
  console.log(`\nresults: ${outPath}`);
};
harden(main);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
