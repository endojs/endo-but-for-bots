/* global process */
// Direct-xst runner for the immutable-arraybuffer property-assignment parity
// suite on XS (Moddable's engine).
//
// Why not the eshost-backed `test262-harness` used for the ses-xs-parity suite?
// That harness only ever fed XS an *empty* prelude (`prelude/xs.js`), because
// the ses-xs-parity tests exercise intrinsics XS provides natively. Our parity
// suite needs the @endo/immutable-arraybuffer shim installed on XS via a real
// (bundled) prelude, and eshost's XS agent template does not compose with a
// non-empty prelude (it injects `$SOURCE`/`$262` scaffolding that collides with
// the bundle). Running `xst` directly on `prelude + harness + test` is the same
// idiom `@endo/ses`'s own `test:xs` uses (`xst dist/ses.umd.js test/...`), and
// it exercises the identical test262-format sources the Node run uses.
//
// Usage: XST=/path/to/xst node scripts/run-iab-xs.js   (XST defaults to `xst`)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = fileURLToPath(new URL('..', import.meta.url));
const xst = process.env.XST || 'xst';
const preludePath = path.join(root, 'prelude', 'iab.js');
const harnessDir = path.join(root, 'test262', 'harness');
const testDir = path.join(
  root,
  'test262',
  'test',
  'staging',
  'immutable-arraybuffer',
);

if (!fs.existsSync(preludePath)) {
  console.error(
    `Missing ${preludePath}. Run \`yarn build\` (generate-preludes) first.`,
  );
  process.exit(2);
}

const prelude = fs.readFileSync(preludePath, 'utf8');
const readHarness = name =>
  fs.readFileSync(path.join(harnessDir, name), 'utf8');
// assert.js + sta.js are the implicit test262 includes; every test relies on them.
const baseHarness = `${readHarness('assert.js')}\n${readHarness('sta.js')}\n`;

const parseFrontmatter = source => {
  const m = source.match(/\/\*---([\s\S]*?)---\*\//);
  const yaml = m ? m[1] : '';
  const flagsMatch = yaml.match(/flags:\s*\[([^\]]*)\]/);
  const includesMatch = yaml.match(/includes:\s*\[([^\]]*)\]/);
  const flags = flagsMatch
    ? flagsMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
  const includes = includesMatch
    ? includesMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
  return { flags, includes };
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iab-xs-'));
let passed = 0;
let failed = 0;

const runVariant = (name, strict, includes, source) => {
  const extraIncludes = includes.map(readHarness).join('\n');
  const body = `${prelude}\n${baseHarness}${extraIncludes}\n${source}`;
  const contents = strict ? `"use strict";\n${body}` : body;
  const file = path.join(tmpDir, `${name}-${strict ? 'strict' : 'sloppy'}.js`);
  fs.writeFileSync(file, contents);
  const label = `${name} (${strict ? 'strict' : 'sloppy'})`;
  const result = spawnSync(xst, ['-s', file], { encoding: 'utf8' });
  if (result.error) {
    console.error(`ERROR launching ${xst}: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status === 0) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}`);
    const out = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (out) console.log(`  ${out.split('\n')[0]}`);
  }
};

const testFiles = fs
  .readdirSync(testDir)
  .filter(f => f.endsWith('.js'))
  .sort();

for (const f of testFiles) {
  const source = fs.readFileSync(path.join(testDir, f), 'utf8');
  const { flags, includes } = parseFrontmatter(source);
  const name = f.replace(/\.js$/, '');
  const onlyStrict = flags.includes('onlyStrict');
  const noStrict = flags.includes('noStrict') || flags.includes('raw');
  if (!noStrict) runVariant(name, true, includes, source);
  if (!onlyStrict) runVariant(name, false, includes, source);
}

console.log(
  `\nRan ${passed + failed} tests\n${passed} passed\n${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
