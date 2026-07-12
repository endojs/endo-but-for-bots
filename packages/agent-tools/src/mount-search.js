// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { MountSearchToolCapability, ToolRecord } from './types.js' */

import { E } from '@endo/eventual-send';

import { makeTool } from './tool.js';

/**
 * Default cap on the number of results a search tool returns. Chosen well below
 * the engine's own `GLOB_MAX_RESULTS` so an over-broad pattern surfaces a
 * `truncated: true` flag the primer teaches the model to react to, rather than
 * flooding its context.
 */
const DEFAULT_MAX_RESULTS = 1000;

/**
 * The default file-selection glob for `mountGrep`: every file under the mount
 * face. Named as a tool parameter (not baked in) so a caller narrows the search
 * set cheaply.
 */
const DEFAULT_FILES_GLOB = '**/*';

/**
 * Reject a tool-arguments record that carries any key outside `allowed` before
 * any capability send. The advertised schemas set `additionalProperties:
 * false`, but the JSON Schema is descriptive only; this enforces it at runtime
 * the same way the mount-fs tools do.
 *
 * @param {Record<string, unknown>} args
 * @param {string[]} allowed
 * @param {string} toolName
 */
const assertOnlyKeys = (args, allowed, toolName) => {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new Error(`unexpected ${toolName} argument key "${key}"`);
    }
  }
};

/**
 * Coerce and validate an optional positive-integer `maxResults` argument.
 *
 * @param {unknown} value
 * @param {string} toolName
 * @returns {number}
 */
const resolveMaxResults = (value, toolName) => {
  if (value === undefined) {
    return DEFAULT_MAX_RESULTS;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${toolName} maxResults must be a positive integer`);
  }
  return value;
};

/** JSON Schema for `mountGlob`. Used verbatim as LLM `parameters` and MCP `inputSchema`. */
const mountGlobParameters = harden({
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Glob pattern, mount-relative. Metacharacters are only `*` (within ' +
        'one path segment, matches dot-files) and `**` (a whole segment, any ' +
        'depth); every other character is literal, so `?`, `[`, `{` need no ' +
        'escaping.',
    },
    maxResults: {
      type: 'number',
      description: `Maximum number of paths to return (default ${DEFAULT_MAX_RESULTS}). When more match, the result is capped and \`truncated\` is true.`,
    },
  },
  required: ['pattern'],
  additionalProperties: false,
});

/** JSON Schema for `mountGrep`. */
const mountGrepParameters = harden({
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'A JavaScript regular expression source (no flags), matched against ' +
        'each line.',
    },
    filesGlob: {
      type: 'string',
      description: `Glob selecting which files to search (default ${JSON.stringify(DEFAULT_FILES_GLOB)}, i.e. every file). Same metacharacters as mountGlob.`,
    },
    maxResults: {
      type: 'number',
      description: `Maximum number of match records to return (default ${DEFAULT_MAX_RESULTS}). When more match, the result is capped and \`truncated\` is true.`,
    },
  },
  required: ['pattern'],
  additionalProperties: false,
});

/**
 * A read-only file-name search tool bound to an `EndoMount`-shaped capability
 * (its `glob`). Returns sorted, mount-relative paths and a `truncated` flag.
 *
 * The capability is the smallest slice — `Pick<EndoMount, 'glob' | 'grep'>` —
 * locally typed to avoid a circular `@endo/daemon` dependency, exactly as
 * `git-mount-tool.js` types its worktree slice. Binding an
 * `ERef<Filesystem>` like the other mount-fs tools was considered and deferred:
 * it requires the extended capability filesystem to grow engine-backed search
 * first (the consolidation follow-up); the tool can rebind then with no schema
 * change. Confinement, deny filtering, and revocation are enforced by the
 * mount capability this tool receives.
 *
 * @param {ERef<MountSearchToolCapability>} mount
 * @returns {ToolRecord}
 */
export const makeMountGlobTool = mount => {
  return makeTool({
    name: 'mountGlob',
    description:
      'Find files by name under a mount. Pattern metacharacters are only `*` ' +
      '(within one path segment, matches dot-files) and `**` (a whole ' +
      'segment, any depth); everything else is literal. Returns sorted ' +
      'mount-relative paths and a `truncated` flag. Denied names (.ssh, .env, ' +
      '…) and paths escaping the mount never appear.',
    parameters: mountGlobParameters,
    execute: async args => {
      assertOnlyKeys(args, ['pattern', 'maxResults'], 'mountGlob');
      const { pattern, maxResults: maxResultsArg } =
        /** @type {{ pattern?: unknown, maxResults?: unknown }} */ (args);
      if (typeof pattern !== 'string' || pattern === '') {
        throw new Error('mountGlob requires a non-empty string pattern');
      }
      const maxResults = resolveMaxResults(maxResultsArg, 'mountGlob');
      const raw = await E(mount).glob(pattern);
      const truncated = raw.length > maxResults;
      const paths = truncated ? raw.slice(0, maxResults) : [...raw];
      return harden({ paths, truncated });
    },
  });
};
harden(makeMountGlobTool);

/**
 * A read-only content search tool bound to an `EndoMount`-shaped capability.
 * Searches file contents for a JavaScript regular expression, over the files a
 * `filesGlob` selects, returning `{ file, line, text }` matches and a
 * `truncated` flag.
 *
 * The tool performs the glob→grep composition itself —
 * `E(mount).grep(pattern, E(mount).glob(filesGlob))` — deliberately: an LLM
 * calling two tools would pay a round trip *and* the token cost of ferrying the
 * path list back through its context. The tool-level `filesGlob` is convenience
 * at the tool layer; the *capabilities* stay decoupled (grep does not own
 * glob). See designs/platform-search-pushdown.md § "Agent tool surface".
 *
 * @param {ERef<MountSearchToolCapability>} mount
 * @returns {ToolRecord}
 */
export const makeMountGrepTool = mount => {
  return makeTool({
    name: 'mountGrep',
    description:
      'Search file contents under a mount. `pattern` is a JavaScript regular ' +
      'expression (no flags); `filesGlob` narrows which files are searched ' +
      '(default every file). Returns `{ file, line, text }` matches (1-based ' +
      'lines) and a `truncated` flag. Prefer one mountGrep with a filesGlob ' +
      'over mountGlob plus many reads.',
    parameters: mountGrepParameters,
    execute: async args => {
      assertOnlyKeys(args, ['pattern', 'filesGlob', 'maxResults'], 'mountGrep');
      const {
        pattern,
        filesGlob: filesGlobArg,
        maxResults: maxResultsArg,
      } = /** @type {{ pattern?: unknown, filesGlob?: unknown, maxResults?: unknown }} */ (
        args
      );
      if (typeof pattern !== 'string' || pattern === '') {
        throw new Error('mountGrep requires a non-empty string pattern');
      }
      if (filesGlobArg !== undefined && typeof filesGlobArg !== 'string') {
        throw new Error('mountGrep filesGlob must be a string');
      }
      const filesGlob =
        filesGlobArg === undefined ? DEFAULT_FILES_GLOB : filesGlobArg;
      const maxResults = resolveMaxResults(maxResultsArg, 'mountGrep');
      // The pipeline seam: the unresolved glob promise flows straight into
      // grep, which the mount's exo awaits (the `M.await` path guard) before it
      // runs — no intermediate path list crosses back through this tool.
      // Request one extra record so an exactly-full result is distinguishable
      // from a genuinely truncated one.
      const raw = await E(mount).grep(pattern, E(mount).glob(filesGlob), {
        maxResults: maxResults + 1,
      });
      const truncated = raw.length > maxResults;
      const matches = (truncated ? raw.slice(0, maxResults) : [...raw]).map(
        ({ file, line, text }) => ({ file, line, text }),
      );
      return harden({ matches, truncated });
    },
  });
};
harden(makeMountGrepTool);

/**
 * The composite search-tool slice for a mount: `mountGlob` + `mountGrep`. Both
 * are `scope: 'read'` and survive `readOnly` composition (search adds no write
 * authority). Mirrors `makeMountFsTools`' shape so a host assembles the mount
 * tool surface uniformly.
 *
 * @param {ERef<MountSearchToolCapability>} mount
 * @returns {ToolRecord[]}
 */
export const makeMountSearchTools = mount => {
  return harden([makeMountGlobTool(mount), makeMountGrepTool(mount)]);
};
harden(makeMountSearchTools);
