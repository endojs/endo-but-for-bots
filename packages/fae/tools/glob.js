// @ts-check
/* global process */

import { makeExo } from '@endo/exo';

import { FaeToolInterface } from '../src/fae-tool-interface.js';
import { makeGlobTool } from '../src/tool-makers.js';

/**
 * FaeTool caplet: find paths matching a glob pattern (`*` within a segment,
 * `**` across segments; the platform search engine's dialect) under a root
 * directory. Root is set at creation time via env.FAE_CWD (default:
 * process.cwd()).
 * @param _powers
 * @param _context
 * @param root0
 * @param root0.env
 */
// eslint-disable-next-line no-underscore-dangle
export const make = (_powers, _context, { env = {} }) => {
  const cwd =
    /** @type {Record<string, string | undefined>} */ (env).FAE_CWD ||
    process.cwd();
  const impl = makeGlobTool(cwd);
  return makeExo('GlobTool', FaeToolInterface, {
    schema: () => impl.schema(),
    execute: args => impl.execute(args),
    help: () => impl.help(),
  });
};
harden(make);
