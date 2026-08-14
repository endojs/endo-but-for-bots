// @ts-check
/* global process */

import { makeExo } from '@endo/exo';

import { FaeToolInterface } from '../src/fae-tool-interface.js';
import { makeGrepTool } from '../src/tool-makers.js';

/**
 * FaeTool caplet: search file contents for an ECMAScript regular expression
 * under a root directory. Root is set at creation time via env.FAE_CWD
 * (default: process.cwd()).
 *
 * @param {unknown} _powers
 * @param {unknown} _context
 * @param {{ env?: Record<string, string | undefined> }} options
 */
export const make = (_powers, _context, { env = {} }) => {
  const cwd = env.FAE_CWD || process.cwd();
  const impl = makeGrepTool(cwd);
  return makeExo('GrepTool', FaeToolInterface, {
    schema: () => impl.schema(),
    execute: args => impl.execute(args),
    help: () => impl.help(),
  });
};
harden(make);
