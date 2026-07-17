// @ts-check
/* global process */
/* eslint-disable no-continue */

/**
 * Filesystem Tools Module
 *
 * Provides read, write, edit, glob, grep, remove, and stat file tools
 * with path-root enforcement.
 * All accessed paths must resolve under the configured root directory.
 *
 * File I/O is delegated to a {@link VFS} backend so that the tool
 * logic is decoupled from Node-specific APIs.  By default,
 * {@link makeNodeVFS} is used, but callers may supply any conforming
 * implementation.
 *
 * The edit tool delegates to the shared exact-string-replacement
 * algorithm (`@endo/agentry/edit-text`) and the glob/grep tools to the
 * shared platform search engine (`@endo/platform/fs/search`), so the
 * semantics presented here are the same ones Lal, Fae, and the daemon
 * mount present (designs/fs-interface-reconciliation.md).
 */

import { resolve, dirname, relative, basename } from 'path';
import harden from '@endo/harden';
import { M } from '@endo/patterns';
import { applyEdits, normalizeEdits } from '@endo/agentry/edit-text';
import {
  makeSearch,
  GLOB_MAX_RESULTS,
  GREP_MAX_RESULTS,
} from '@endo/platform/fs/search';

import { makeTool } from './common.js';
import { makeNodeVFS } from './vfs-node.js';

/** @import { VFS } from './vfs.js' */

/** @type {number} */
const DEFAULT_MAX_READ_BYTES = 100 * 1024 * 1024; // 100 MiB

/**
 * @typedef {object} FileToolsOptions
 * @property {string} [root] - Root directory that all paths must resolve
 *   under. Defaults to `process.cwd()`.
 * @property {number} [maxReadBytes] - Maximum number of bytes a single
 *   readFile call may return.  Defaults to 100 MiB.
 * @property {VFS} [vfs] - Virtual filesystem backend.  Defaults to
 *   a Node.js `fs`-backed implementation.
 */

/**
 * Resolve `userPath` against `root` and assert the result stays under `root`.
 *
 * @param {string} userPath - The path supplied by the caller.
 * @param {string} root     - The root directory all paths must stay within.
 * @returns {string} The resolved absolute path.
 */
const safePath = (userPath, root) => {
  if (userPath.includes('\0')) {
    throw new Error('Invalid path: null bytes not allowed');
  }
  const resolved = resolve(root, userPath);
  const rel = relative(root, resolved);
  // If the relative path starts with ".." or is absolute, it escapes the root.
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`Invalid path: must resolve under root (${root})`);
  }
  return resolved;
};

/**
 * Compute the byte length of a UTF-8 string without relying on
 * Node's `Buffer`.
 *
 * @param {string} str
 * @returns {number}
 */
const utf8ByteLength = str => new TextEncoder().encode(str).byteLength;

/**
 * Create file-system tools (readFile, writeFile, editFile) that enforce a
 * common path-root traversal limit.
 *
 * @param {FileToolsOptions} [options]
 */
const makeFileTools = (options = {}) => {
  const {
    root = process.cwd(),
    maxReadBytes = DEFAULT_MAX_READ_BYTES,
    vfs = makeNodeVFS(),
  } = options;
  const resolvedRoot = resolve(root);

  const readFile = makeTool('readFile', {
    *help() {
      yield 'Reads the text content of a single FILE. Cannot read directories.';
      yield '';
      yield 'IMPORTANT: This tool only works on files, NOT directories.';
      yield 'To see what is inside a directory, use listDirectory instead.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Path to a file (required). Must be a file, not a directory.';
      yield '- `offset`: Starting byte offset (optional)';
      yield '- `limit`: Maximum bytes to read (optional)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'readFile({ path: "README.md" })';
      yield '```';
    },

    schema: M.call(
      M.splitRecord(
        { path: M.string() },
        { offset: M.number(), limit: M.number() },
      ),
    ).returns(
      M.splitRecord(
        {
          success: M.boolean(),
          path: M.string(),
          content: M.string(),
          bytesRead: M.number(),
        },
        { offset: M.number(), limit: M.number() },
      ),
    ),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @param {number} [opts.offset]
     * @param {number} [opts.limit]
     * @returns {Promise<{success: boolean, path: string, content: string, bytesRead: number, offset?: number, limit?: number}>}
     */
    async execute({ path, offset = 0, limit = maxReadBytes }) {
      await Promise.resolve();

      if (limit > maxReadBytes) {
        throw new Error(
          `Limit exceeds platform max read limit of ${maxReadBytes} bytes`,
        );
      }

      const fullPath = safePath(path, resolvedRoot);

      try {
        // Check file size up-front so we can enforce the platform limit
        // and validate the offset without reading the whole file.
        const { size: fileSize } = await vfs.stat(fullPath);
        if (offset >= fileSize && fileSize > 0) {
          throw new Error('Offset exceeds file size');
        }

        // Determine how many bytes we will actually read.
        const bytesToRead = Math.min(limit, fileSize - offset);

        // Stream only the requested byte range via the VFS.
        const stream = vfs.createReadStream(fullPath, {
          start: offset,
          end: offset + bytesToRead - 1, // `end` is inclusive
        });

        /** @type {Uint8Array[]} */
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of stream) {
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
        }

        // Decode the collected bytes to a UTF-8 string.
        const decoder = new TextDecoder();
        const content =
          chunks.length === 1
            ? decoder.decode(chunks[0])
            : decoder.decode(
                (() => {
                  const merged = new Uint8Array(totalBytes);
                  let pos = 0;
                  for (const c of chunks) {
                    merged.set(c, pos);
                    pos += c.byteLength;
                  }
                  return merged;
                })(),
              );

        return {
          success: true,
          path,
          offset,
          limit,
          content,
          bytesRead: totalBytes,
        };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }
    },
  });

  const writeFile = makeTool('writeFile', {
    *help() {
      yield 'Creates or completely overwrites a file with new content.';
      yield '';
      yield 'Use writeFile to create new files or fully replace file content.';
      yield 'To change only part of an existing file, use editFile instead.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Path to file (required)';
      yield '- `content`: Full content to write (required)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'writeFile({ path: "test.txt", content: "Hello World" })';
      yield '```';
    },

    schema: M.call({ path: M.string(), content: M.string() }).returns({
      success: M.boolean(),
      path: M.string(),
      bytesWritten: M.number(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @param {string} opts.content
     * @returns {Promise<{success: boolean, path: string, bytesWritten: number}>}
     */
    async execute({ path, content }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      try {
        const dir = dirname(fullPath);
        await vfs.mkdir(dir, { recursive: true });
        await vfs.writeFile(fullPath, content);

        return {
          success: true,
          path,
          bytesWritten: utf8ByteLength(content),
        };
      } catch (err) {
        throw new Error(
          `Failed to write file: ${/** @type {Error} */ (err).message}`,
        );
      }
    },
  });

  // -- editFile --------------------------------------------------------------

  const editFile = makeTool('editFile', {
    *help() {
      yield 'Edits a file by exact-string replacement, without rewriting the whole file.';
      yield '';
      yield 'Each edit replaces a uniquely-matching `oldText` with `newText`.';
      yield 'Read the file first with readFile to find the exact text to replace.';
      yield 'If `oldText` matches more than one place, the edit is rejected —';
      yield 'add surrounding context so it matches exactly once.';
      yield 'Line endings and a leading BOM are preserved, and a unified diff';
      yield 'of the change is returned.';
      yield 'To create a new file or fully rewrite one, use writeFile instead.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Path to file (required)';
      yield '- `oldText`: Exact unique string to find and replace';
      yield '- `newText`: Replacement string';
      yield '- `edits`: Array of `{ oldText, newText }` pairs to apply several';
      yield '  non-overlapping edits in one call (alternative to the single pair)';
      yield '';
      yield '**Examples:**';
      yield '```';
      yield 'editFile({ path: "README.md", oldText: "old text", newText: "new text" })';
      yield 'editFile({ path: "a.js", edits: [{ oldText: "x = 1", newText: "x = 2" }] })';
      yield '```';
    },

    schema: M.call(
      M.splitRecord(
        { path: M.string() },
        {
          oldText: M.string(),
          newText: M.string(),
          edits: M.arrayOf(
            M.splitRecord({ oldText: M.string(), newText: M.string() }),
          ),
        },
      ),
    ).returns({
      success: M.boolean(),
      path: M.string(),
      applied: M.number(),
      diff: M.string(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @param {string} [opts.oldText]
     * @param {string} [opts.newText]
     * @param {Array<{oldText: string, newText: string}>} [opts.edits]
     * @returns {Promise<{success: boolean, path: string, applied: number, diff: string}>}
     */
    async execute({ path, oldText, newText, edits }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);
      const normalized = normalizeEdits({ oldText, newText, edits });

      let before;
      try {
        before = await vfs.readFile(fullPath);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }

      // The shared algorithm's errors (non-unique match, overlap, not
      // found) propagate as-is so every agent surface reports them in
      // the same words.
      const { content, diff, applied } = applyEdits(before, normalized, {
        fileName: path,
      });
      await vfs.writeFile(fullPath, content);

      return { success: true, path, applied, diff };
    },
  });

  // -- removeFile ------------------------------------------------------------

  const removeFile = makeTool('removeFile', {
    *help() {
      yield 'Deletes a single file. Cannot remove directories.';
      yield '';
      yield 'To remove a directory, use removeDirectory instead.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Path to the file to delete (required)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'removeFile({ path: "tmp/scratch.txt" })';
      yield '```';
    },

    schema: M.call({ path: M.string() }).returns({
      success: M.boolean(),
      path: M.string(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @returns {Promise<{success: boolean, path: string}>}
     */
    async execute({ path }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      try {
        await vfs.unlink(fullPath);
        return { success: true, path };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new Error(`File not found: ${path}`);
        }
        throw new Error(
          `Failed to remove file: ${/** @type {Error} */ (err).message}`,
        );
      }
    },
  });

  // -- stat -----------------------------------------------------------------

  const stat = makeTool('stat', {
    *help() {
      yield 'Checks if a path exists and returns its type (file or directory) and size.';
      yield '';
      yield 'Use stat to find out whether a path is a file or a directory before';
      yield 'deciding whether to use readFile or listDirectory.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Path to file or directory (required)';
      yield '';
      yield '**Returns:** `{ success, path, type, size, modified }`';
      yield '  - `type` is one of: "file", "directory", "symlink", "other"';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'stat({ path: "src" })  // returns type: "directory"';
      yield '```';
    },

    schema: M.call({ path: M.string() }).returns({
      success: M.boolean(),
      path: M.string(),
      type: M.string(),
      size: M.number(),
      modified: M.string(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @returns {Promise<{success: boolean, path: string, type: string, size: number, modified: string}>}
     */
    async execute({ path }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      try {
        const info = await vfs.stat(fullPath);

        return {
          success: true,
          path,
          type: info.type,
          size: info.size,
          modified: info.mtime,
        };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new Error(`Path not found: ${path}`);
        }
        throw new Error(
          `Failed to stat path: ${/** @type {Error} */ (err).message}`,
        );
      }
    },
  });

  // -- listDirectory --------------------------------------------------------

  const listDirectory = makeTool('listDirectory', {
    *help() {
      yield 'Lists the files and subdirectories inside a directory.';
      yield '';
      yield 'Use this tool to explore what is inside a folder.';
      yield 'This is the correct tool when you want to see directory contents.';
      yield 'Do NOT use readFile on a directory — use listDirectory instead.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Directory path to list (required)';
      yield '- `recursive`: Include nested contents (optional, default: false)';
      yield '- `glob`: Filter by pattern, e.g. "*.js" (optional)';
      yield '';
      yield '**Returns:** `{ success, path, entries: [{ name, type, size }] }`';
      yield '';
      yield '**Examples:**';
      yield '```';
      yield 'listDirectory({ path: "." })              // list current directory';
      yield 'listDirectory({ path: "src" })             // list src/ folder';
      yield 'listDirectory({ path: "src", glob: "*.js" })  // only .js files';
      yield '```';
    },

    schema: M.call(
      M.splitRecord(
        { path: M.string() },
        { recursive: M.boolean(), glob: M.string() },
      ),
    ).returns({
      success: M.boolean(),
      path: M.string(),
      entries: M.arrayOf(
        M.splitRecord({ name: M.string(), type: M.string(), size: M.number() }),
      ),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @param {boolean} [opts.recursive]
     * @param {string} [opts.glob]
     * @returns {Promise<{success: boolean, path: string, entries: Array<{name: string, type: string, size: number}>}>}
     */
    async execute({ path, recursive = false, glob: globPattern }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      try {
        /** @type {RegExp | undefined} */
        let re;
        if (globPattern) {
          // Convert simple glob to regex: * -> [^/]*, ? -> [^/], ** -> .*
          const escaped = globPattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '\0')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')
            .replace(/\0/g, '.*');
          re = new RegExp(`^${escaped}$`);
        }

        /** @type {Array<{name: string, type: string, size: number}>} */
        const entries = [];

        for await (const { name, type, size } of vfs.readdir(fullPath, {
          recursive,
        })) {
          if (re && !(re.test(basename(name)) || re.test(name))) {
            continue;
          }
          entries.push({ name, type, size });
        }

        return { success: true, path, entries };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new Error(`Directory not found: ${path}`);
        }
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOTDIR') {
          throw new Error(`Not a directory: ${path}`);
        }
        throw new Error(
          `Failed to list directory: ${/** @type {Error} */ (err).message}`,
        );
      }
    },
  });

  // -- makeDirectory --------------------------------------------------------

  const makeDirectory = makeTool('makeDirectory', {
    *help() {
      yield 'Creates a new directory (folder).';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Directory path to create (required)';
      yield '- `recursive`: Also create parent directories if missing (optional, default: false)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'makeDirectory({ path: "src/utils", recursive: true })';
      yield '```';
    },

    schema: M.call(
      M.splitRecord({ path: M.string() }, { recursive: M.boolean() }),
    ).returns({
      success: M.boolean(),
      path: M.string(),
      created: M.boolean(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @param {boolean} [opts.recursive]
     * @returns {Promise<{success: boolean, path: string, created: boolean}>}
     */
    async execute({ path, recursive: rec = false }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      try {
        const created = await vfs.mkdir(fullPath, { recursive: rec });
        return { success: true, path, created };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
          return { success: true, path, created: false };
        }
        throw new Error(
          `Failed to create directory: ${/** @type {Error} */ (err).message}`,
        );
      }
    },
  });

  // -- removeDirectory ------------------------------------------------------

  const removeDirectory = makeTool('removeDirectory', {
    *help() {
      yield 'Deletes a directory (folder). To delete a single file, use removeFile.';
      yield '';
      yield '**Parameters:**';
      yield '- `path`: Directory path to delete (required)';
      yield '- `recursive`: Delete all contents inside first (optional, default: false)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'removeDirectory({ path: "tmp/build", recursive: true })';
      yield '```';
    },

    schema: M.call(
      M.splitRecord({ path: M.string() }, { recursive: M.boolean() }),
    ).returns({
      success: M.boolean(),
      path: M.string(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.path
     * @param {boolean} [opts.recursive]
     * @returns {Promise<{success: boolean, path: string}>}
     */
    async execute({ path, recursive: rec = false }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      // Refuse to remove the root itself.
      if (fullPath === resolvedRoot) {
        throw new Error('Refusing to remove the root directory');
      }

      try {
        if (rec) {
          await vfs.rm(fullPath, { recursive: true });
        } else {
          await vfs.rmdir(fullPath);
        }
        return { success: true, path };
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
          throw new Error(`Directory not found: ${path}`);
        }
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOTEMPTY') {
          throw new Error(
            `Directory not empty: ${path} (use recursive: true to remove)`,
          );
        }
        throw new Error(
          `Failed to remove directory: ${/** @type {Error} */ (err).message}`,
        );
      }
    },
  });

  // -- glob / grep -----------------------------------------------------------

  // Adapt the VFS read surface to the platform search engine's narrow
  // `SearchPowers` contract. A VFS without `realPath` (memory, mount) is
  // treated as symlink-free — each path is its own physical path —
  // matching the lexical confinement the rest of the tool suite applies.
  const search = makeSearch(
    harden({
      /** @param {string} path */
      readDirectory: async path => {
        await null;
        const names = [];
        for await (const entry of vfs.readdir(path, { recursive: false })) {
          names.push(entry.name);
        }
        return harden(names);
      },
      /** @param {string} path */
      isDirectory: async path => {
        await null;
        try {
          return (await vfs.stat(path)).type === 'directory';
        } catch {
          return false;
        }
      },
      /** @param {string} path */
      readFileText: path => vfs.readFile(path),
      /** @param {string[]} segments */
      joinPath: (...segments) => vfs.join(...segments),
      /** @param {string} path */
      maybeRealPath: async path => {
        await null;
        if (vfs.realPath === undefined) {
          return path;
        }
        try {
          return await vfs.realPath(path);
        } catch {
          return undefined;
        }
      },
    }),
  );

  const glob = makeTool('glob', {
    *help() {
      yield 'Finds paths matching a glob pattern, like `find` with globs.';
      yield '';
      yield 'Returns matching paths relative to the searched directory, sorted.';
      yield '`*` matches within one path segment, `**` matches across segments,';
      yield '`?` matches a single character.';
      yield '';
      yield '**Parameters:**';
      yield '- `pattern`: Glob pattern, e.g. "src/**/*.js" (required)';
      yield '- `path`: Directory to search under (optional, default: the root)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'glob({ pattern: "**/*.test.js", path: "src" })';
      yield '```';
    },

    schema: M.call(
      M.splitRecord({ pattern: M.string() }, { path: M.string() }),
    ).returns({
      success: M.boolean(),
      path: M.string(),
      pattern: M.string(),
      matches: M.arrayOf(M.string()),
      truncated: M.boolean(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.pattern
     * @param {string} [opts.path]
     * @returns {Promise<{success: boolean, path: string, pattern: string, matches: string[], truncated: boolean}>}
     */
    async execute({ pattern, path = '.' }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      /** @type {string[]} */
      const matches = [];
      let truncated = false;
      for await (const batch of search.globPaths(fullPath, pattern, {
        confinementRoot: resolvedRoot,
      })) {
        for (const match of batch) {
          if (matches.length >= GLOB_MAX_RESULTS) {
            truncated = true;
            break;
          }
          matches.push(match);
        }
        if (truncated) {
          break;
        }
      }

      return { success: true, path, pattern, matches, truncated };
    },
  });

  const grep = makeTool('grep', {
    *help() {
      yield 'Searches file contents for a regular expression, like `grep -n`.';
      yield '';
      yield 'Returns matches as `{ file, line, text }` records in path-then-line';
      yield 'order, with 1-based line numbers and paths relative to the searched';
      yield 'directory. Unreadable (e.g. binary) files are skipped.';
      yield '';
      yield '**Parameters:**';
      yield '- `pattern`: ECMAScript regular expression source (required)';
      yield '- `path`: Directory to search under (optional, default: the root)';
      yield '- `glob`: Only search files matching this glob pattern (optional)';
      yield '';
      yield '**Example:**';
      yield '```';
      yield 'grep({ pattern: "TODO\\\\(", path: "src", glob: "**/*.js" })';
      yield '```';
    },

    schema: M.call(
      M.splitRecord(
        { pattern: M.string() },
        { path: M.string(), glob: M.string() },
      ),
    ).returns({
      success: M.boolean(),
      path: M.string(),
      pattern: M.string(),
      matches: M.arrayOf({
        file: M.string(),
        line: M.number(),
        text: M.string(),
      }),
      truncated: M.boolean(),
    }),

    /**
     * @param {object} opts
     * @param {string} opts.pattern
     * @param {string} [opts.path]
     * @param {string} [opts.glob]
     * @returns {Promise<{success: boolean, path: string, pattern: string, matches: Array<{file: string, line: number, text: string}>, truncated: boolean}>}
     */
    async execute({ pattern, path = '.', glob: globPattern }) {
      await Promise.resolve();

      const fullPath = safePath(path, resolvedRoot);

      const paths =
        globPattern === undefined
          ? undefined
          : search.globPaths(fullPath, globPattern, {
              confinementRoot: resolvedRoot,
              includeDirectories: false,
            });

      // Ask for one match beyond the cap so truncation is detectable
      // without misreporting an exactly-at-cap result as truncated.
      /** @type {Array<{file: string, line: number, text: string}>} */
      const matches = [];
      for await (const batch of search.grepFiles(fullPath, pattern, paths, {
        confinementRoot: resolvedRoot,
        maxResults: GREP_MAX_RESULTS + 1,
      })) {
        matches.push(...batch);
      }
      const truncated = matches.length > GREP_MAX_RESULTS;
      if (truncated) {
        matches.length = GREP_MAX_RESULTS;
      }

      return { success: true, path, pattern, matches, truncated };
    },
  });

  return harden({
    readFile,
    writeFile,
    editFile,
    removeFile,
    stat,
    listDirectory,
    glob,
    grep,
    makeDirectory,
    removeDirectory,
  });
};
harden(makeFileTools);

export { makeFileTools };
export default makeFileTools;
