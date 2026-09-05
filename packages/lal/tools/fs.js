// @ts-check
/**
 * Filesystem-shaped tools that read or write text through
 * tree-shaped capabilities. Search tools target capabilities such as
 * EndoMount that expose the daemon-local glob/grep extensions.
 *
 * @import { Pattern } from '@endo/patterns'
 */

import { M } from '@endo/patterns';
import { NamePathShape, NameOrPathShape } from '@endo/daemon/type-guards.js';

/** @import { LalToolDef } from './index.js' */

/** @type {LalToolDef[]} */
export const fsToolDefs = harden([
  {
    name: 'makeDirectory',
    summary:
      'Create a new subdirectory at the given path. ' +
      'Argument: petNamePath (string[]).',
    params: M.splitRecord({ petNamePath: NamePathShape }),
  },
  {
    name: 'readText',
    summary:
      'Read text content from a capability (ReadableTree, WritableTree, etc.). ' +
      'Arguments: petNameOrPath, fileName (string).',
    params: M.splitRecord({
      petNameOrPath: NameOrPathShape,
      fileName: M.string(),
    }),
  },
  {
    name: 'writeText',
    summary:
      'Write text content to a capability (WritableTree, etc.). ' +
      'Arguments: petNameOrPath, fileName (string), content (string).',
    params: M.splitRecord({
      petNameOrPath: NameOrPathShape,
      fileName: M.string(),
      content: M.string(),
    }),
  },
  {
    name: 'editText',
    summary:
      'Edit a text file in a capability (WritableTree, etc.) by exact-string ' +
      'replacement, without re-sending the whole file. Each edit replaces a ' +
      'uniquely-matching `oldText` with `newText`; pass several edits to apply ' +
      'them in one call (they must not overlap). Line endings and a leading BOM ' +
      'are preserved, and a unified diff of the change is returned. ' +
      'Arguments: petNameOrPath, fileName (string), edits (array of ' +
      '{ oldText, newText }).',
    params: M.splitRecord({
      petNameOrPath: NameOrPathShape,
      fileName: M.string(),
      edits: M.arrayOf(
        M.splitRecord({
          oldText: M.string(),
          newText: M.string(),
        }),
      ),
    }),
  },
  {
    name: 'glob',
    summary:
      'Find paths recursively within a search-capable filesystem capability. ' +
      'The glob dialect supports `*` within one path segment and `**` across ' +
      'segments; every other character, including `?`, is literal. ' +
      '`**` reports a directory symlink but does not descend through it, so ' +
      'the walk covers the tree rather than the link graph; a segment that ' +
      'names a path still follows one, so ' +
      '"node_modules/@endo/*/src/**/*.js" reaches through workspace links. ' +
      'Set followSymlinks to sweep through links as well (`rg -L`) — expect ' +
      'a much larger result set, since in a workspace checkout every ' +
      'node_modules link points back into the tree. ' +
      'Arguments: petNameOrPath, pattern (string), ' +
      'followSymlinks (optional boolean).',
    params: M.splitRecord(
      {
        petNameOrPath: NameOrPathShape,
        pattern: M.string(),
      },
      {
        followSymlinks: M.boolean(),
      },
    ),
  },
  {
    name: 'grep',
    summary:
      'Search file contents within a search-capable filesystem capability ' +
      'using an ECMAScript regular-expression source with no flags. Optionally ' +
      'restrict files with a glob pattern and cap the number of results. ' +
      'Returns { file, line, text } records with 1-based line numbers. ' +
      'Arguments: petNameOrPath, pattern (string), glob (optional string), ' +
      'maxResults (optional positive number), ' +
      'followSymlinks (optional boolean).',
    params: M.splitRecord(
      {
        petNameOrPath: NameOrPathShape,
        pattern: M.string(),
      },
      {
        glob: M.string(),
        // Governs only the walk that finds the files — the implicit one when
        // no `glob` is given, or the `glob` enumeration when one is. Files
        // named by that walk are read either way, so this never changes what
        // happens to a file once it has been found. See the `glob` tool.
        followSymlinks: M.boolean(),
        // A positive finite count. Bare `M.number()` admits `NaN`/`+/-Infinity`
        // (Endo's pass-style treats them as valid numbers), and the daemon's cap
        // (`matches.length >= maxResults`) only defaults on `undefined`, so those
        // values would defeat the result cap — and `NaN` additionally coerces
        // `slice(0, maxResults)` to `slice(0, 0)`, silently returning no matches.
        // `0` is the same silent-empty hazard (`slice(0, 0)` → `[]`), so the
        // lower bound is `1`, not `0`: a zero cap is indistinguishable to the
        // caller from a genuinely empty result set. The explicit `M.number()`
        // conjunct names the type so a bigint/string argument fails with a type
        // diagnostic rather than incidentally via cross-passStyle key ordering.
        maxResults: M.and(M.number(), M.gte(1), M.lte(Number.MAX_SAFE_INTEGER)),
      },
    ),
  },
]);
