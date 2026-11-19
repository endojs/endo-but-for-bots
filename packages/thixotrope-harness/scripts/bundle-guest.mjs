#!/usr/bin/env node
// @ts-check
/**
 * Bundle a guest program, `guest/<program>/main.js`, into one source string
 * for an Ironhorse vat (architecture.md section 1).
 *
 * The bundle is compartment-mapper `makeBundle` output: evaluating it yields
 * the program's module namespace. Guest modules read the prelude (`E`, `Far`,
 * `M`, `makeExo`, ...) off `globalThis`, so the bundle carries no `@endo/*`
 * library: `guest/package.json` declares no dependencies, so a bare import
 * fails to resolve, and every module the bundler reads is checked to lie
 * inside the guest package root.
 *
 * Usage:
 *   node scripts/bundle-guest.mjs [--out DIR] [program ...]
 * With no program, every `guest/<program>/main.js` is bundled. Each bundle
 * is written to `DIR/<program>.js` (default `dist-guest/`) and one JSON line
 * per program is printed: {"program","bytes","digest","modules"}. A bundle
 * file is written aside and renamed into place, so concurrent runs are safe.
 */
import './_init.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const harnessRoot = path.resolve(here, '..');
export const defaultGuestRoot = path.join(harnessRoot, 'guest');

/**
 * The nearest directory at or above `start` holding a package.json.
 * @param {string} start
 */
const findPackageRoot = start => {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw Error(`No package.json above ${start}`);
    dir = parent;
  }
};

/**
 * @param {string} child
 * @param {string} parent
 */
const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

/**
 * Non-ASCII units that JavaScript reads as white space or a line terminator
 * in code: an escape is not white space, so they cannot be rewritten without
 * knowing whether they stand in code or in a string.
 */
const NON_ASCII_SPACE =
  /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/**
 * The source with every non-ASCII UTF-16 unit written as a `\uXXXX` escape,
 * so a bundle is ASCII: its UTF-8 bytes equal its units.
 *
 * compartment-mapper's module transform names its hidden bindings with an
 * invisible U+034F (`$h\u034f_imports`; `@endo/module-source`
 * src/hidden.js), 216 of them in the session program (J-0244). An escape
 * names the same binding in an identifier and the same text in a string, a
 * regular expression or a template's cooked value; in a comment it is
 * harmless. It would change a template's raw text, which the guest lint
 * (`ascii-outside-comments`) keeps out of guest code; an astral character
 * in an identifier would not survive (two escaped surrogates) and none
 * occurs. Refused (thrown), because an escape would change their meaning:
 * a non-ASCII unit right after a backslash (an identity escape), and
 * non-ASCII white space or line terminators.
 *
 * @param {string} source
 * @returns {string}
 */
export const escapeNonAscii = source =>
  source.replace(/[\u0080-\uffff]/g, (unit, offset) => {
    const code = unit.charCodeAt(0).toString(16).padStart(4, '0');
    let backslashes = 0;
    for (let i = offset - 1; i >= 0 && source[i] === '\\'; i -= 1)
      backslashes += 1;
    if (backslashes % 2 === 1 || NON_ASCII_SPACE.test(unit))
      throw Error(
        `Cannot escape U+${code} at offset ${offset} of the bundle (after a backslash, or white space)`,
      );
    return `\\u${code}`;
  });

// Use the parser and printer paired by compartment-mapper's module transform.
const requireHere = createRequire(import.meta.url);
const requireMapper = createRequire(
  requireHere.resolve('@endo/compartment-mapper/package.json'),
);
const requireSource = createRequire(
  requireMapper.resolve('@endo/module-source/package.json'),
);
const loadParser = () =>
  /** @type {{ parse: (source: string, options: object) => any }} */ (
    requireSource('@babel/parser')
  );

/**
 * Print the final session program from its syntax tree. The generated script
 * must still evaluate to the module namespace. Its bindings, literal values
 * and capability-sized property names are visible to the guest.
 * @param {string} source
 */
const compactSession = source => {
  const ast = loadParser().parse(source, { sourceType: 'script' });
  const { default: generate } = requireSource('@babel/generator');
  return /** @type {string} */ (
    generate(ast, { compact: true, comments: false }, source).code
  );
};

/**
 * Link only sources admitted by compartment-mapper. Keep its original
 * program for cyclic graphs, dynamic imports, mutable public exports and
 * resolution forms outside the explicit relative imports used by the guest.
 * Rollup preserves lexical declarations while linking. Terser keeps the
 * linked program in ESM so the mapper creates the public namespace.
 *
 * @param {string} entry absolute entry path
 * @param {Map<string, Uint8Array>} sources admitted absolute paths
 */
const linkSession = async (entry, sources) => {
  const parser = loadParser();
  const ast = parser.parse(new TextDecoder().decode(sources.get(entry)), {
    sourceType: 'module',
  });
  const exports = ast.program.body.filter((/** @type {any} */ stmt) =>
    stmt.type.startsWith('Export'),
  );
  if (
    !exports.length ||
    !exports.every(
      (/** @type {any} */ stmt) =>
        stmt.type === 'ExportNamedDeclaration' &&
        stmt.declaration?.kind === 'const',
    )
  )
    return undefined;
  const [{ rollup }, { minify }] = await Promise.all([
    import('rollup'),
    import('terser'),
  ]);
  let supported = true;
  const graph = await rollup({
    input: entry,
    treeshake: {
      annotations: false,
      correctVarValueBeforeDeclaration: true,
      moduleSideEffects: true,
      propertyReadSideEffects: 'always',
      tryCatchDeoptimization: true,
      unknownGlobalSideEffects: true,
    },
    onwarn: () => {
      supported = false;
    },
    plugins: [
      {
        name: 'admitted-guest-modules',
        resolveId(specifier, importer) {
          if (importer === undefined && specifier === entry) return entry;
          const file =
            importer && path.resolve(path.dirname(importer), specifier);
          if (file && /^\.{1,2}\//.test(specifier) && sources.has(file))
            return file;
          supported = false;
          return false;
        },
        resolveDynamicImport() {
          supported = false;
          return false;
        },
        load(id) {
          const bytes = sources.get(id);
          if (bytes === undefined)
            throw Error(`Unadmitted session module ${id}`);
          return new TextDecoder().decode(bytes);
        },
      },
    ],
  });
  try {
    if (!supported) return undefined;
    const { output } = await graph.generate({ format: 'es' });
    if (!supported || output.length !== 1) return undefined;
    const { code } = await minify(output[0].code, {
      module: true,
      keep_fnames: true,
      keep_classnames: true,
      compress: { passes: 3 },
      format: { ascii_only: true, comments: false },
    });
    return code === undefined ? undefined : new TextEncoder().encode(code);
  } finally {
    await graph.close();
  }
};

/**
 * A guest module's source without its comments (J-0303): every comment is
 * replaced by the line breaks it held (a block comment on one line by one
 * space), so line numbers stay the same, and white space left at a line's
 * end is dropped. Comments are found by parsing the module, never by a
 * pattern, so text in strings, templates and regular expressions is kept.
 * Bundle bytes are the frames a vat is staged with (session program budget
 * 200,000 bytes; exec `execProgramBytes`), and comments were about 40 % of
 * them.
 *
 * @param {string} source
 * @param {string} [where] for error messages
 * @returns {string}
 */
export const stripComments = (source, where = 'module') => {
  /** @type {{ comments?: Array<{ start: number, end: number, type: string }> }} */
  let ast;
  try {
    ast = loadParser().parse(source, {
      sourceType: 'module',
      allowReturnOutsideFunction: false,
    });
  } catch (error) {
    throw Error(`Cannot parse ${where} to strip its comments: ${error}`);
  }
  const comments = [...(ast.comments ?? [])].sort((a, b) => a.start - b.start);
  /** @type {string[]} */
  const parts = [];
  let at = 0;
  for (const { start, end, type } of comments) {
    parts.push(source.slice(at, start));
    if (type === 'CommentBlock') {
      const breaks = source.slice(start, end).split('\n').length - 1;
      parts.push(breaks === 0 ? ' ' : '\n'.repeat(breaks));
    }
    at = end;
  }
  parts.push(source.slice(at));
  return parts.join('').replace(/[ \t]+$/gm, '');
};

/**
 * A bundle without the blanks and tabs that start its lines (J-9698), except
 * inside a template literal or a string literal that spans lines, where they
 * are text. Found by parsing the bundle as a script, never by a pattern.
 * Line breaks stay, so line numbers and the token stream are unchanged; it
 * runs once on the whole bundle, so compartment-mapper's own scaffolding
 * loses its indentation too. Bundle bytes are paid per vat staged (D-4).
 *
 * @param {string} source
 * @param {string} [where] for error messages
 * @returns {string}
 */
export const dropIndentation = (source, where = 'bundle') => {
  /** @type {any} */
  let ast;
  try {
    ast = loadParser().parse(source, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw Error(`Cannot parse ${where} to drop its indentation: ${error}`, {
      cause: error,
    });
  }
  const skipped = new Set([
    'loc',
    'leadingComments',
    'trailingComments',
    'innerComments',
    'extra',
  ]);
  /** @param {any} node */
  const isTextRange = node =>
    node.type === 'TemplateLiteral' ||
    ((node.type === 'StringLiteral' || node.type === 'DirectiveLiteral') &&
      source.slice(node.start, node.end).includes('\n'));
  /** @type {Array<[number, number]>} ranges whose line starts are text */
  const kept = [];
  /** @type {unknown[]} */
  const stack = [ast.program];
  while (stack.length) {
    const node = /** @type {any} */ (stack.pop());
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (typeof node === 'object' && node !== null) {
      if (typeof node.type === 'string' && isTextRange(node)) {
        // A template whole, expressions included: simpler, and rare.
        kept.push([node.start, node.end]);
      } else {
        for (const key of Object.keys(node)) {
          const value = node[key];
          if (!skipped.has(key) && typeof value === 'object' && value !== null)
            stack.push(value);
        }
      }
    }
  }
  kept.sort((a, b) => a[0] - b[0]);
  /** @type {string[]} */
  const parts = [];
  let at = 0;
  let range = 0;
  for (let lineStart = 0; lineStart < source.length;) {
    const breakAt = source.indexOf('\n', lineStart);
    const lineEnd = breakAt === -1 ? source.length : breakAt + 1;
    while (range < kept.length && kept[range][1] <= lineStart) range += 1;
    const inside =
      range < kept.length &&
      kept[range][0] < lineStart &&
      lineStart < kept[range][1];
    if (!inside) {
      let first = lineStart;
      while (
        first < lineEnd &&
        (source[first] === ' ' || source[first] === '\t')
      )
        first += 1;
      if (first > lineStart) {
        parts.push(source.slice(at, lineStart));
        at = first;
      }
    }
    lineStart = lineEnd;
  }
  parts.push(source.slice(at));
  return parts.join('');
};

/**
 * @typedef {object} GuestBundle
 * @property {string} entry absolute path of the entry module
 * @property {string} guestRoot the guest package root every module lies in
 * @property {string} source the bundle: one script whose value is the
 *   namespace, ASCII (`escapeNonAscii`)
 * @property {number} bytes UTF-8 length of `source`
 * @property {string} digest SHA-256 of `source`, hex
 * @property {string[]} modules guest-root-relative paths of the bundled modules
 */

/**
 * @param {string} entry path of the program's main module
 * @param {object} [options]
 * @param {string} [options.guestRoot] defaults to the entry's package root,
 *   which must be a package with no dependencies
 * @param {boolean} [options.comments] keep comments (default false:
 *   `stripComments`)
 * @returns {Promise<GuestBundle>}
 */
export const bundleGuest = async (
  entry,
  { guestRoot, comments = false } = {},
) => {
  const entryPath = path.resolve(entry);
  const root = path.resolve(
    guestRoot ?? findPackageRoot(path.dirname(entryPath)),
  );
  if (!isInside(entryPath, root))
    throw Error(`Guest entry ${entryPath} is outside the guest root ${root}`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    if (manifest[field] && Object.keys(manifest[field]).length)
      throw Error(
        `Guest package ${root} declares ${field}; guest code reads the prelude from globalThis and bundles nothing from node_modules`,
      );
  }
  // Loaded here, after ./_init.mjs has locked down: compartment-mapper reads
  // the `assert` global when it loads, and a static import may evaluate
  // before the lockdown module's top-level await completes.
  const [{ makeBundle }, { makeReadPowers }] = await Promise.all([
    import('@endo/compartment-mapper/bundle.js'),
    import('@endo/compartment-mapper/node-powers.js'),
  ]);
  const readPowers = makeReadPowers({ fs, url, crypto, path });
  const optimizedSession =
    !comments &&
    path.relative(root, entryPath) === path.join('session', 'main.js');
  /** @type {Map<string, Uint8Array>} */
  const sources = new Map();
  /** @type {Set<string>} */
  const modules = new Set();
  /** @type {string[]} */
  const outside = [];
  /** @param {string} location */
  const note = location => {
    const file = url.fileURLToPath(location);
    if (path.basename(file) === 'package.json') return;
    if (isInside(file, root)) modules.add(path.relative(root, file));
    else outside.push(file);
  };
  /**
   * A guest module's bytes without comments; anything else unchanged.
   * @param {string} location
   * @param {Uint8Array} bytes
   */
  const stripped = (location, bytes) => {
    if (comments || !location.endsWith('.js')) return bytes;
    const file = url.fileURLToPath(location);
    if (!isInside(file, root)) return bytes;
    const text = new TextDecoder().decode(bytes);
    const result = new TextEncoder().encode(stripComments(text, file));
    if (optimizedSession) sources.set(file, result);
    return result;
  };
  const recordingPowers = {
    ...readPowers,
    /** @param {string} location */
    read: async location => {
      note(location);
      return stripped(location, await readPowers.read(location));
    },
    /** @param {string} location */
    maybeRead: async location => {
      const bytes = await readPowers.maybeRead(location);
      if (bytes !== undefined) note(location);
      return bytes === undefined ? bytes : stripped(location, bytes);
    },
  };
  const source = await makeBundle(
    recordingPowers,
    url.pathToFileURL(entryPath).href,
  );
  if (outside.length)
    throw Error(
      `Guest bundle ${entryPath} reads modules outside ${root}: ${outside.join(', ')}`,
    );
  let program = source;
  if (optimizedSession) {
    const linked = await linkSession(entryPath, sources);
    const entryUrl = url.pathToFileURL(entryPath).href;
    const linkedProgram =
      linked === undefined
        ? source
        : await makeBundle(
            {
              ...readPowers,
              read: location =>
                location === entryUrl
                  ? Promise.resolve(linked)
                  : readPowers.read(location),
              maybeRead: location =>
                location === entryUrl
                  ? Promise.resolve(linked)
                  : readPowers.maybeRead(location),
            },
            entryUrl,
          );
    program = compactSession(linkedProgram);
  } else if (!comments) {
    program = dropIndentation(source, entryPath);
  }
  const ascii = escapeNonAscii(program);
  const encoded = new TextEncoder().encode(ascii);
  return harden({
    entry: entryPath,
    guestRoot: root,
    source: ascii,
    bytes: encoded.length,
    digest: crypto.createHash('sha256').update(encoded).digest('hex'),
    modules: [...modules].sort(),
  });
};

/**
 * Programs under a guest root: directories with a `main.js`.
 * @param {string} [guestRoot]
 */
export const listGuestPrograms = async (guestRoot = defaultGuestRoot) => {
  const entries = await readdir(guestRoot, { withFileTypes: true });
  const programs = [];
  for (const entry of entries) {
    const main = path.join(guestRoot, entry.name, 'main.js');
    const found = entry.isDirectory()
      ? await stat(main).catch(() => undefined)
      : undefined;
    if (found?.isFile()) programs.push(entry.name);
  }
  return programs.sort();
};

/** @param {string} message */
const Fail = message => {
  throw Error(message);
};

/** @param {string[]} argv */
export const parseBundleArgs = argv => {
  let out = path.join(harnessRoot, 'dist-guest');
  let guestRoot = defaultGuestRoot;
  /** @type {string[]} */
  const programs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      i += 1;
      out = path.resolve(argv[i] ?? Fail('--out needs a directory'));
    } else if (arg === '--guest-root') {
      i += 1;
      guestRoot = path.resolve(argv[i] ?? Fail('--guest-root needs a path'));
    } else if (arg.startsWith('-')) {
      throw Error(`Unknown option ${arg}`);
    } else {
      if (!/^[a-z][a-z0-9-]*$/.test(arg))
        throw Error(`Program names are lower-case words: ${arg}`);
      programs.push(arg);
    }
  }
  return { out, guestRoot, programs };
};

/** @param {string[]} argv */
export const main = async argv => {
  const options = parseBundleArgs(argv);
  const programs = options.programs.length
    ? options.programs
    : await listGuestPrograms(options.guestRoot);
  await mkdir(options.out, { recursive: true });
  const results = [];
  for (const program of programs) {
    const bundle = await bundleGuest(
      path.join(options.guestRoot, program, 'main.js'),
      { guestRoot: options.guestRoot },
    );
    // Written aside and renamed into place: a reader never sees half a
    // bundle while another process writes the same one.
    const target = path.join(options.out, `${program}.js`);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await writeFile(temporary, bundle.source);
    await rename(temporary, target);
    const row = {
      program,
      bytes: bundle.bytes,
      digest: bundle.digest,
      modules: bundle.modules,
    };
    process.stdout.write(`${JSON.stringify(row)}\n`);
    results.push(row);
  }
  return results;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`bundle-guest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
