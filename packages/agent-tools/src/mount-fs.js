// @ts-check
/// <reference types="ses"/>

/** @import { ERef } from '@endo/eventual-send' */
/** @import { Directory, File, Filesystem } from '@endo/platform/fs/extended' */
/** @import { ToolRecord } from './types.js' */

import { E } from '@endo/eventual-send';
import { walk, collectBytes } from '@endo/platform/fs/extended';

import { makeTool } from './tool.js';

/**
 * Default text-read truncation cap, in characters. A `maxChars` option of `0`
 * disables truncation entirely.
 */
const DEFAULT_MAX_TEXT_CHARS = 50_000;

/**
 * JSON Schema for the single `path` parameter the mount read tool advertises.
 * Used verbatim as both the LLM `parameters` and the MCP `inputSchema` by
 * `makeTool`.
 */
const mountReadTextParameters = harden({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Mount-relative path to the file to read.',
    },
  },
  required: ['path'],
  additionalProperties: false,
});

const mountWriteTextParameters = harden({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Mount-relative path to the file to write.',
    },
    content: {
      type: 'string',
      description: 'UTF-8 text content to write.',
    },
  },
  required: ['path', 'content'],
  additionalProperties: false,
});

const mountListParameters = harden({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Mount-relative path to the directory to list.',
    },
  },
  required: ['path'],
  additionalProperties: false,
});

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string[]} allowed
 */
const rejectExtraArgs = (toolName, args, allowed) => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) {
      throw new Error(`unexpected ${toolName} argument key "${key}"`);
    }
  }
};

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string} key
 * @returns {string}
 */
const requireStringArg = (toolName, args, key) => {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${toolName} requires a non-empty string ${key}`);
  }
  return value;
};

/**
 * `walk` expects one `Directory.lookup` segment at a time. Empty path
 * components become `.` no-op steps, so `/a`, `a//b`, and `a/` work.
 *
 * @param {string} path
 * @returns {string[]}
 */
const pathSegments = path =>
  path
    .split('/')
    .map(segment => segment || '.')
    .filter(segment => segment !== '.');

/**
 * @param {ERef<Filesystem>} fs
 * @param {string[]} segments
 * @returns {Promise<Directory>}
 */
const directoryAt = async (fs, segments) =>
  /** @type {Promise<Directory>} */ (
    /** @type {unknown} */ (walk(E(fs).root(), segments))
  );

/**
 * A read-only filesystem tool bound to an `@endo/platform/fs/extended`
 * `Filesystem` capability. Reads a single text file by root-relative path and
 * returns its UTF-8 contents.
 *
 * Built through {@link makeTool}, so it emits a canonical `ToolRecord`
 * (`name`/`description`/`parameters`/`inputSchema`/`invoke`) at parity with the
 * git tools and flows through `toPiAgentTool` unchanged.
 *
 * The path is split into `Filesystem` segments and resolved by `walk`.
 * Confinement, symlink containment, and revocation are enforced by the
 * `Filesystem` capability this tool receives.
 *
 * @param {ERef<Filesystem>} fs An `@endo/platform/fs/extended` `Filesystem` ERef. Callers
 *   can attenuate authority with `readOnly` or `chroot`.
 * @param {object} [opts] Configuration options.
 * @param {number} [opts.maxChars] Maximum number of UTF-8 characters returned
 *   before the result is truncated. Defaults to `DEFAULT_MAX_TEXT_CHARS`
 *   (50,000). A value of `0` disables the limit; the full file contents are
 *   returned untruncated.
 * @returns {ToolRecord}
 */
export const makeMountReadTool = (fs, opts = {}) => {
  const { maxChars = DEFAULT_MAX_TEXT_CHARS } = opts;
  const limitDisabled = maxChars === 0;
  // `open().read(0n, length)` is exclusive of `length`, so request one extra
  // byte to detect overflow past the cap. With the limit disabled, read the
  // whole file in one unbounded request.
  const readLength = limitDisabled ? undefined : BigInt(maxChars + 1);

  return makeTool({
    name: 'mountReadText',
    description:
      'Read a UTF-8 text file from the mounted project directory. ' +
      'Path is relative to the mount root; "../" escapes are rejected.',
    parameters: mountReadTextParameters,
    execute: async args => {
      for (const key of Object.keys(args)) {
        if (key !== 'path') {
          throw new Error(`unexpected mountReadText argument key "${key}"`);
        }
      }
      const { path } = /** @type {{ path?: unknown }} */ (args);
      if (typeof path !== 'string' || path === '') {
        throw new Error('mountReadText requires a non-empty string path');
      }
      const segments = pathSegments(path);
      const file = /** @type {File} */ (
        /** @type {unknown} */ (walk(E(fs).root(), segments))
      );
      const openFile = E(file).open({ read: true });
      // `read(offset)` with the length omitted reads to EOF, which is what we
      // want when the limit is disabled (`maxChars === 0`).
      const reader = await E(openFile).read(0n, readLength);
      const bytes = await collectBytes(/** @type {object} */ (reader));
      const content = new TextDecoder().decode(bytes);
      if (!limitDisabled && content.length > maxChars) {
        return `${content.slice(0, maxChars)}\n\n... (truncated at ${maxChars} chars)`;
      }
      return content;
    },
  });
};
harden(makeMountReadTool);

/**
 * A writable filesystem tool bound to an `@endo/platform/fs/extended`
 * `Filesystem` capability. Writes UTF-8 text to a file by root-relative path,
 * creating the file when absent and truncating prior contents on overwrite.
 *
 * The path is split into `Filesystem` segments and resolved by `walk`.
 * Confinement, symlink containment, and revocation are enforced by the
 * `Filesystem` capability this tool receives.
 *
 * @param {ERef<Filesystem>} fs An `@endo/platform/fs/extended` `Filesystem` ERef.
 * @returns {ToolRecord}
 */
export const makeMountWriteTool = fs =>
  makeTool({
    name: 'mountWriteText',
    description:
      'Write UTF-8 text to the mounted project directory. ' +
      'Path is relative to the mount root; "../" escapes are rejected.',
    parameters: mountWriteTextParameters,
    execute: async args => {
      rejectExtraArgs('mountWriteText', args, ['path', 'content']);
      const path = requireStringArg('mountWriteText', args, 'path');
      const { content } = /** @type {{ content?: unknown }} */ (args);
      if (typeof content !== 'string') {
        throw new Error('mountWriteText requires a string content');
      }
      const segments = pathSegments(path);
      const name = segments.pop();
      if (name === undefined) {
        throw new Error('mountWriteText requires a file path');
      }
      const dir = await directoryAt(fs, segments);
      await E(/** @type {object} */ (dir)).write(name, content);
      return undefined;
    },
  });
harden(makeMountWriteTool);

/**
 * A directory listing filesystem tool bound to an
 * `@endo/platform/fs/extended` `Filesystem` capability. Returns only child
 * names and kinds, keeping cursor and node capabilities out of the result.
 *
 * The path is split into `Filesystem` segments and resolved by `walk`.
 * Confinement, symlink containment, and revocation are enforced by the
 * `Filesystem` capability this tool receives.
 *
 * @param {ERef<Filesystem>} fs An `@endo/platform/fs/extended` `Filesystem` ERef.
 * @returns {ToolRecord}
 */
export const makeMountListTool = fs =>
  makeTool({
    name: 'mountList',
    description:
      'List child names and kinds in the mounted project directory. ' +
      'Path is relative to the mount root; "../" escapes are rejected.',
    parameters: mountListParameters,
    execute: async args => {
      rejectExtraArgs('mountList', args, ['path']);
      const path = requireStringArg('mountList', args, 'path');
      const dir = await directoryAt(fs, pathSegments(path));
      const cursor = await E(/** @type {object} */ (dir)).list();
      const entries = /** @type {{ name: string, kind: string }[]} */ (
        await E(cursor).toArray()
      );
      return harden(
        entries.map(({ name, kind }) =>
          harden({
            name,
            kind,
          }),
        ),
      );
    },
  });
harden(makeMountListTool);
