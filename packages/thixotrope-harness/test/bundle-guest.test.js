// @ts-check
import test from '@endo/ses-ava/test.js';

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  bundleGuest,
  dropIndentation,
  escapeNonAscii,
  listGuestPrograms,
  parseBundleArgs,
} from '../scripts/bundle-guest.mjs';
import {
  guestRoot,
  programPieceBytes,
  sessionEntry,
  sessionProgramBytes,
} from '../scripts/provision-steps.js';
import { harnessRoot, scratch } from './_helpers.js';

const fixtureRoot = path.join(harnessRoot, 'test', 'fixtures', 'guest');
const tinyEntry = path.join(fixtureRoot, 'tiny', 'main.js');

/**
 * Evaluate a bundle in a compartment whose globals are a stand-in prelude.
 * @param {string} source
 * @param {Record<string, unknown>} globals
 */
const evaluateBundle = (source, globals) =>
  new Compartment({ globals: harden(globals), __options__: true }).evaluate(
    source,
  );

test('a guest program bundles into one source whose value is its namespace', async t => {
  const bundle = await bundleGuest(tinyEntry);
  t.is(bundle.guestRoot, fixtureRoot);
  t.deepEqual(bundle.modules, ['tiny/main.js', 'tiny/words.js']);
  t.is(typeof bundle.source, 'string');
  t.is(bundle.bytes, new TextEncoder().encode(bundle.source).length);
  t.regex(bundle.digest, /^[0-9a-f]{64}$/);

  // Stand-ins for the prelude names the fixture reads off globalThis.
  const calls = [];
  const namespace = evaluateBundle(bundle.source, {
    Far: (/** @type {string} */ name, /** @type {object} */ methods) => {
      calls.push(['Far', name]);
      return methods;
    },
    M: { arrayOf: () => 'arrayOf', string: () => 'string' },
    mustMatch: (/** @type {unknown} */ value, /** @type {unknown} */ shape) =>
      calls.push(['mustMatch', shape]),
  });
  t.deepEqual(Object.keys(namespace), ['make']);
  const tiny = namespace.make();
  t.is(tiny.say(['two', 'words']), 'two words');
  t.deepEqual(calls, [
    ['Far', 'Tiny'],
    ['mustMatch', 'arrayOf'],
  ]);
});

test('the bundle carries no copy of @endo/patterns or any other package', async t => {
  const { source, modules } = await bundleGuest(tinyEntry);
  t.true(modules.every(m => !m.includes('node_modules')));
  t.false(source.includes('node_modules'));
  // makeBundle heads each module with "// === <n>. <package> <path> ===".
  const heads = [...source.matchAll(/^\/\/ === \d+\. (\S+) (\S+) ===$/gm)].map(
    ([, pkg, file]) => `${pkg} ${file}`,
  );
  t.deepEqual(heads.sort(), ['guest ./tiny/main.js', 'guest ./tiny/words.js']);
  // Distinctive definitions from @endo/patterns and @endo/pass-style.
  for (const marker of [
    'makeCopySet',
    'getInterfaceGuardPayload',
    'passStyleOf',
  ]) {
    t.false(source.includes(marker), marker);
  }
  // Small: two modules and the bundle runtime.
  t.true(source.length < 10_000, `${source.length}`);
});

test('the session linker keeps effects, export cells, names and original module accounting', async t => {
  const dir = await scratch(t, 'link');
  const entry = path.join(dir, 'session', 'main.js');
  await mkdir(path.dirname(entry));
  await writeFile(
    path.join(dir, 'package.json'),
    '{"name":"guest","type":"module"}',
  );
  await writeFile(
    path.join(dir, 'counter.js'),
    [
      "globalThis.mark('counter');",
      'let count = 0;',
      'export const read = () => count;',
      'export const advance = () => ++count;',
    ].join('\n'),
  );
  await writeFile(
    path.join(dir, 'effect.js'),
    "globalThis.mark('effect'); export const unused = 1;",
  );
  await writeFile(
    entry,
    [
      "import { read, advance as next } from '../counter.js';",
      'export const advance = () => next();',
      'export const count = () => read();',
      "import { unused } from '../effect.js';",
      "globalThis.mark('entry');",
    ].join('\n'),
  );
  const expectedModules = ['counter.js', 'effect.js', 'session/main.js'];
  for (const comments of [false, true]) {
    const bundle = await bundleGuest(entry, { comments });
    const seen = [];
    const namespace = evaluateBundle(bundle.source, {
      mark: value => seen.push(value),
    });
    t.deepEqual(seen, ['counter', 'effect', 'entry']);
    t.deepEqual(bundle.modules, expectedModules);
    t.deepEqual(Object.keys(namespace).sort(), ['advance', 'count']);
    t.is(namespace.advance.name, 'advance');
    t.is(namespace.count(), 0);
    namespace.advance();
    t.is(namespace.count(), 1);
  }
  await writeFile(
    entry,
    "import { unused } from '@endo/patterns'; export const valid = true;",
  );
  await t.throwsAsync(() => bundleGuest(entry), { message: /@endo\/patterns/ });
});

test('a guest that imports @endo/patterns does not bundle', async t => {
  const dir = await scratch(t, 'bg');
  await mkdir(path.join(dir, 'bad'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'bad-guest', version: '0.0.0', type: 'module' }),
  );
  await writeFile(
    path.join(dir, 'bad', 'main.js'),
    "import { M } from '@endo/patterns';\nexport const shape = M.any();\n",
  );
  await t.throwsAsync(() => bundleGuest(path.join(dir, 'bad', 'main.js')), {
    message: /@endo\/patterns/,
  });
});

test('a guest package that declares dependencies is refused', async t => {
  const dir = await scratch(t, 'bg');
  await mkdir(path.join(dir, 'p'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'dep-guest',
      version: '0.0.0',
      type: 'module',
      dependencies: { '@endo/patterns': 'workspace:^' },
    }),
  );
  await writeFile(path.join(dir, 'p', 'main.js'), 'export const x = 1;\n');
  await t.throwsAsync(() => bundleGuest(path.join(dir, 'p', 'main.js')), {
    message: /declares dependencies/,
  });
});

test('a module outside the guest root is refused', async t => {
  const dir = await scratch(t, 'bg');
  await mkdir(path.join(dir, 'g', 'p'), { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'outer', version: '0.0.0', type: 'module' }),
  );
  await writeFile(
    path.join(dir, 'g', 'package.json'),
    JSON.stringify({ name: 'inner', version: '0.0.0', type: 'module' }),
  );
  await writeFile(path.join(dir, 'outside.js'), 'export const x = 1;\n');
  await writeFile(
    path.join(dir, 'g', 'p', 'main.js'),
    "export { x } from '../../outside.js';\n",
  );
  await t.throwsAsync(
    () =>
      bundleGuest(path.join(dir, 'g', 'p', 'main.js'), {
        guestRoot: path.join(dir, 'g'),
      }),
    { message: /outside/ },
  );
});

test('programs are the directories with a main.js; arguments are checked', async t => {
  const programs = await listGuestPrograms(fixtureRoot);
  t.deepEqual(programs, ['tiny']);
  const parsed = parseBundleArgs(['--out', 'x', 'session', 'exec']);
  t.deepEqual(parsed.programs, ['session', 'exec']);
  t.is(parsed.out, path.resolve('x'));
  t.throws(() => parseBundleArgs(['../evil']), { message: /lower-case/ });
  t.throws(() => parseBundleArgs(['--nope']), { message: /Unknown option/ });
  t.throws(() => parseBundleArgs(['--out']), { message: /needs a directory/ });
});

test('the CLI writes one bundle per program and prints JSON lines', async t => {
  const dir = await scratch(t, 'bc');
  const stdout = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [
        path.join(harnessRoot, 'scripts', 'bundle-guest.mjs'),
        '--guest-root',
        fixtureRoot,
        '--out',
        dir,
      ],
      (error, out) => (error ? reject(error) : resolve(out)),
    ),
  );
  const rows = String(stdout)
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  t.is(rows.length, 1);
  t.is(rows[0].program, 'tiny');
  const written = await readFile(path.join(dir, 'tiny.js'), 'utf8');
  t.is(new TextEncoder().encode(written).length, rows[0].bytes);
});

test('escapeNonAscii keeps identifiers, strings, regexps and cooked templates', t => {
  const source =
    // eslint-disable-next-line no-template-curly-in-string -- guest source text
    "(() => { const $h\u034f_x = 'na\u00efve \u{1F600}'; // caf\u00e9\n return [$h\u034f_x, /\u00e9+/.test('\u00e9\u00e9'), `\u2026${1}`]; })()";
  const escaped = escapeNonAscii(source);
  t.false(/[\u0080-\uffff]/.test(escaped));
  t.true(escaped.includes('$h\\u034f_x'));
  const evaluate = (/** @type {string} */ text) =>
    new Compartment({ __options__: true }).evaluate(text);
  t.deepEqual(evaluate(escaped), evaluate(source));
  t.is(escapeNonAscii('plain ascii\n'), 'plain ascii\n');
});

test('escapeNonAscii refuses what an escape would change', t => {
  t.throws(() => escapeNonAscii("'\\\u00e9'"), {
    message: /after a backslash/,
  });
  t.throws(() => escapeNonAscii('// x\u2028y'), { message: /U\+2028/ });
  t.throws(() => escapeNonAscii('a\u00a0b'), { message: /U\+00a0/ });
  // An escaped backslash before the character is fine.
  t.is(escapeNonAscii("'\\\\\u00e9'"), "'\\\\\\u00e9'");
});

test('dropIndentation keeps templates, multi-line strings, lines and tokens (J-9698)', async t => {
  const source = [
    'const f = () => {',
    '    const a = `x',
    '    y ${1 +',
    '      2}`;',
    "\tconst b = 'p\\",
    "  q';",
    '  return [a, b];',
    '};',
    'f();',
  ].join('\n');
  const dropped = dropIndentation(source);
  t.is(
    dropped,
    [
      'const f = () => {',
      'const a = `x',
      '    y ${1 +',
      '      2}`;',
      "const b = 'p\\",
      "  q';",
      'return [a, b];',
      '};',
      'f();',
    ].join('\n'),
  );
  const evaluate = (/** @type {string} */ text) =>
    new Compartment({ __options__: true }).evaluate(text);
  t.deepEqual(evaluate(dropped), evaluate(source));
  t.throws(() => dropIndentation('const = ;'), { message: /Cannot parse/ });
  // On a real program: same lines, the same text without blanks, smaller.
  const { source: whole } = await bundleGuest(sessionEntry, {
    guestRoot,
    comments: true,
  });
  const undented = dropIndentation(whole);
  t.is(undented.split('\n').length, whole.split('\n').length);
  t.is(undented.replace(/[ \t]/g, ''), whole.replace(/[ \t]/g, ''));
  t.true(undented.length < whole.length);
});

test('the session program bundle is ASCII (J-0244: U+034F hidden names)', async t => {
  const bundle = await bundleGuest(sessionEntry, { guestRoot });
  t.false(/[\u0080-\uffff]/.test(bundle.source));
  t.is(bundle.bytes, bundle.source.length);
  t.true(bundle.source.includes('$h\\u034f_'));
  // Staged in pieces of programPieceBytes (scripts/provision-steps.js).
  const pieces = Math.ceil(bundle.bytes / programPieceBytes);
  t.log(JSON.stringify({ bytes: bundle.bytes, programPieceBytes, pieces }));
  // Within the session-program budget (architecture D-4, perf
  // `session.program`; 240,000 since M5's O-1, 270,336 since WX.1's G-1
  // default), not a snapshot of one
  // milestone's size.
  t.true(bundle.bytes <= sessionProgramBytes);
  t.true(pieces <= Math.ceil(sessionProgramBytes / programPieceBytes));
});
