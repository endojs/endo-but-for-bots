// @ts-check
/* eslint-disable no-template-curly-in-string -- the strings are guest code to lint */
import test from '@endo/ses-ava/test.js';

import { execFile } from 'node:child_process';
import path from 'node:path';

import { harnessRoot } from './_helpers.js';

/**
 * Run ESLint in a plain Node child (it does not load under lockdown).
 * @param {{ cases: string[], rootText: string }} input
 * @returns {Promise<{ ids: string[][], rootRules: Record<string, string[]>, rootLint: { ruleId: string | null, fatal: boolean, message: string }[] }>}
 */
const runLint = input =>
  new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(harnessRoot, 'test', '_lint-runner.mjs')],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(Error(`${error.message}\n${stderr}`))
          : resolve(JSON.parse(stdout)),
    );
    child.stdin?.end(JSON.stringify(input));
  });

const clean = [
  [
    'prelude names from globalThis and relative imports',
    "import { f } from './f.js';\nconst { E, Far, M } = globalThis;\nexport const x = Far('X', { go: () => E(f).go(M.any()) });\n",
  ],
  ['prelude names as globals', "export const x = Far('X', {});\n"],
  [
    'numeric += in a loop',
    'export const sum = xs => { let n = 0; for (let i = 0; i < xs.length; i += 1) n += xs[i]; return n; };\n',
  ],
  [
    'parts pushed and joined',
    "export const j = xs => { const parts = []; for (const x of xs) parts.push(`${x}`); return parts.join(''); };\n",
  ],
  [
    'string += outside any loop',
    "export const s = a => { let out = ''; out += a; return out; };\n",
  ],
  ['Math methods by name', 'export const m = a => Math.max(a, 1);\n'],
  [
    'a JSDoc @import tag',
    "/** @import { T } from './t.js' */\n/** @type {T | undefined} */\nexport const x = undefined;\n",
  ],
  ['a method named import', 'export const f = o => o.import(1);\n'],
  [
    'non-ASCII in a comment (the bundler escapes it)',
    '// caf\u00e9 \u2014 ok\nexport const s = 1;\n',
  ],
  ['a \\u escape in a string', "export const s = '\\u00e9';\n"],
  [
    'array concat in a loop',
    'export const c = xss => { let all = []; for (const xs of xss) all = all.concat(xs); return all; };\n',
  ],
  [
    'data in a Map; literal computed keys (J-9366)',
    "export const f = (m, k, v) => { m.set(k, v); const o = {}; o['fixed'] = 1; o[`also`] = 2; Object.defineProperty(o, 'named', { value: 3 }); return { ['lit']: m.get(k), o }; };\n",
  ],
];

const dirty = [
  [
    'JSON.parse in session or factory code (J-9366)',
    'export const f = text => JSON.parse(text);\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'Object.fromEntries (J-9366)',
    'export const f = pairs => Object.fromEntries(pairs);\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'a computed member write (J-9366)',
    'export const f = (o, k, v) => { o[k] = v; };\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'a computed += (J-9366)',
    'export const f = (o, k) => { o[k] += 1; };\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'a computed key in an object literal (J-9366)',
    'export const f = (k, v) => ({ [k]: v });\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'Object.defineProperty with a data key (J-9366)',
    'export const f = (o, k) => Object.defineProperty(o, k, { value: 1 });\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'Reflect.set with a data key (J-9366)',
    'export const f = (o, k) => Reflect.set(o, k, 1);\n',
    'thixotrope-harness-guest/no-data-keys',
  ],
  [
    'an import of @endo/patterns',
    "import { M } from '@endo/patterns';\nexport const s = M.any();\n",
    'no-restricted-imports',
  ],
  [
    'a re-export from a package',
    "export { E } from '@endo/far';\n",
    'no-restricted-imports',
  ],
  ['Date', 'export const now = () => Date.now();\n', 'no-restricted-globals'],
  [
    'new Date',
    'export const now = () => new Date();\n',
    'no-restricted-globals',
  ],
  [
    'Math.random',
    'export const r = () => Math.random();\n',
    'no-restricted-properties',
  ],
  [
    'an alias of Math',
    'const m = Math;\nexport const r = () => m.random();\n',
    'no-restricted-syntax',
  ],
  [
    'setTimeout',
    'export const later = f => setTimeout(f, 1);\n',
    'no-restricted-globals',
  ],
  [
    'setInterval',
    'export const tick = f => setInterval(f, 1);\n',
    'no-restricted-globals',
  ],
  [
    'console',
    "export const say = () => console.log('x');\n",
    'no-restricted-globals',
  ],
  [
    'WeakRef',
    'export const w = o => new WeakRef(o);\n',
    'no-restricted-globals',
  ],
  [
    'globalThis.Date',
    'export const now = () => globalThis.Date.now();\n',
    'no-restricted-syntax',
  ],
  [
    'Date destructured from globalThis',
    'const { E, Date: D } = globalThis;\nexport const now = () => [E, D];\n',
    'no-restricted-syntax',
  ],
  [
    'a dynamic import',
    "export const load = () => import('./x.js');\n",
    'no-restricted-syntax',
  ],
  [
    'string += of a literal in a for loop',
    "export const s = n => { let out = ''; for (let i = 0; i < n; i += 1) out += 'x'; return out; };\n",
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
  [
    'string += of a variable in a for-of loop when the target started as a string',
    "export const s = xs => { let out = ''; for (const x of xs) { out += x; } return out; };\n",
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
  [
    'String.fromCharCode += in a while loop',
    'export const s = b => { let out; let i = 0; while (i < b.length) { out += String.fromCharCode(b[i]); i += 1; } return out; };\n',
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
  [
    's = s + x in a loop',
    "export const s = xs => { let out = ''; for (const x of xs) out = out + x; return out; };\n",
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
  [
    'a template literal += on a property in forEach',
    'export const s = (o, xs) => { xs.forEach(x => { o.text += `${x}`; }); };\n',
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
  [
    'globalThis indexed by a computed key',
    "export const now = () => globalThis['Date'].now();\n",
    'no-restricted-syntax',
  ],
  [
    'an alias of globalThis',
    'const g = globalThis;\nexport const now = () => g.Date.now();\n',
    'no-restricted-syntax',
  ],
  [
    'Reflect.get on globalThis',
    "export const now = () => Reflect.get(globalThis, 'Date').now();\n",
    'no-restricted-syntax',
  ],
  [
    'Date destructured from globalThis by assignment',
    'let D;\n({ Date: D } = globalThis);\nexport const now = () => D.now();\n',
    'no-restricted-syntax',
  ],
  [
    'indirect eval',
    "export const now = () => (0, eval)('Date.now()');\n",
    'no-restricted-syntax',
  ],
  [
    'new Function',
    "export const f = () => new Function('return 1');\n",
    'no-restricted-syntax',
  ],
  [
    's = x + s (prepend) in a loop',
    "export const s = xs => { let out = ''; for (const x of xs) out = x + out; return out; };\n",
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
  [
    'import( in a JSDoc type (SES rejects the bundle, J-0244)',
    "/** @type {import('./t.js').T} */\nexport const x = 1;\n",
    'thixotrope-harness-guest/no-ses-rejected-source',
  ],
  [
    'import( in a string',
    "export const s = 'import(x)';\n",
    'thixotrope-harness-guest/no-ses-rejected-source',
  ],
  [
    'import followed by a comment',
    "export const s = 'import /* x */';\n",
    'thixotrope-harness-guest/no-ses-rejected-source',
  ],
  [
    'an HTML comment marker in a template',
    'export const s = `<!-- x`;\n',
    'thixotrope-harness-guest/no-ses-rejected-source',
  ],
  [
    'a dynamic import is also rejected as source text',
    "export const load = () => import('./x.js');\n",
    'thixotrope-harness-guest/no-ses-rejected-source',
  ],
  [
    'non-ASCII in a string',
    "export const s = 'caf\u00e9';\n",
    'thixotrope-harness-guest/ascii-outside-comments',
  ],
  [
    'non-ASCII in a template literal',
    'export const s = `\u2026`;\n',
    'thixotrope-harness-guest/ascii-outside-comments',
  ],
  [
    'non-ASCII in an identifier',
    'export const caf\u00e9 = 1;\n',
    'thixotrope-harness-guest/ascii-outside-comments',
  ],
  [
    's = s.concat(x) in a loop',
    "export const s = xs => { let out = ''; for (const x of xs) out = out.concat(x); return out; };\n",
    'thixotrope-harness-guest/no-string-concat-in-loop',
  ],
];
const rootText =
  "import { M } from '@endo/patterns';\nexport const s = M.any();\nharden(s);\n";
/** @type {ReturnType<typeof runLint>} */
let linted;
test.before(() => {
  linted = runLint({
    cases: [...clean.map(([, code]) => code), ...dirty.map(([, code]) => code)],
    rootText,
  });
});

clean.forEach(([title], i) => {
  test(`lint allows ${title}`, async t => {
    const { ids } = await linted;
    t.deepEqual(ids[i], []);
  });
});
dirty.forEach(([title, , ruleId], i) => {
  test(`lint forbids ${title}`, async t => {
    const result = await linted;
    const ids = result.ids[clean.length + i];
    t.true(ids.includes(ruleId), JSON.stringify(ids));
  });
});

test('the root config applies the guest rules to guest/ and guest fixtures only', async t => {
  const { rootRules } = await linted;
  for (const rules of [rootRules.guest, rootRules.fixture]) {
    t.true(rules.includes('thixotrope-harness-guest/no-string-concat-in-loop'));
    t.true(rules.includes('no-restricted-imports'));
  }
  t.false(
    rootRules.script.includes(
      'thixotrope-harness-guest/no-string-concat-in-loop',
    ),
  );
});

test('a guest importing @endo/patterns fails lint under the root config', async t => {
  const { rootLint } = await linted;
  const ids = rootLint.map(m => m.ruleId ?? m.message);
  t.true(ids.includes('no-restricted-imports'), JSON.stringify(ids));
  t.false(
    rootLint.some(m => m.fatal),
    JSON.stringify(ids),
  );
});
