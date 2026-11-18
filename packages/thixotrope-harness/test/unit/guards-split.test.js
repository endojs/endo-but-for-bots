// @ts-check
/**
 * X1: the interface tables split per vat program (`guest/lib/guards/*.js`,
 * the chain base < session < factory < `interfaces.js`) and the M2 fold
 * (m2-interfaces.md 1.3). Proof of no behaviour change:
 * - every guard, shape, method list and fixed text deep-equals its snapshot
 *   from before the split (`test/fixtures/guard-snapshot-before-x1.json`),
 *   where the fold maps `interfaces.X` (and `m1bInterfaces.X`,
 *   `methodNames.X`) of the ten interfaces M2 extends to the old
 *   `m2Interfaces.X` (`m2MethodNames.X`);
 * - the gateway's key and method sets are identical;
 * - each guard module's tables answer the same objects as `interfaces.js`;
 * - every name a guest module reads from a guard module's table is in it,
 *   and no vat program bundles `lib/interfaces.js`.
 */
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { guardSnapshot } from './_guard-snapshot.js';
import { bundleGuest } from '../../scripts/bundle-guest.mjs';
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import * as full from '../../guest/lib/interfaces.js';
import * as base from '../../guest/lib/guards/base.js';
import * as session from '../../guest/lib/guards/session.js';
import * as factory from '../../guest/lib/guards/factory.js';
/* eslint-enable import/no-relative-packages */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const harness = path.resolve(here, '../..');
const guestRoot = path.join(harness, 'guest');

/** @type {ReturnType<typeof guardSnapshot>} */
const before = JSON.parse(
  readFileSync(
    path.join(harness, 'test/fixtures/guard-snapshot-before-x1.json'),
    'utf8',
  ),
);

/** The ten interfaces M2 extends (m2-interfaces.md 1.3). */
const TEN = [
  'Session',
  'SessionInternal',
  'QueueEntry',
  'ContextSource',
  'SessionFactory',
  'HarnessRoot',
  'Operator',
  'AgentHostAdmin',
  'Backend',
  'Composer',
];

/**
 * The snapshot key a folded entry is compared with.
 * @param {string} key `table.name`
 */
const beforeKeyOf = key => {
  const dot = key.indexOf('.');
  if (dot < 0) return key;
  const table = key.slice(0, dot);
  const name = key.slice(dot + 1);
  if (!TEN.includes(name)) return key;
  if (table === 'interfaces' || table === 'm1bInterfaces')
    return `m2Interfaces.${name}`;
  if (table === 'methodNames') return `m2MethodNames.${name}`;
  return key;
};

test('every guard, shape, method list and text equals its snapshot from before the split (M2 versions folded)', t => {
  const after = guardSnapshot();
  t.deepEqual(
    Object.keys(after.entries).sort(),
    Object.keys(before.entries).sort(),
    'the same entries in every table',
  );
  for (const [table, names] of Object.entries(before.order)) {
    t.deepEqual(
      [...after.order[table]].sort(),
      [...names].sort(),
      `${table}: the same names`,
    );
  }
  let folded = 0;
  for (const [key, digest] of Object.entries(after.entries)) {
    const old = beforeKeyOf(key);
    if (old !== key) folded += 1;
    t.is(digest, before.entries[old], `${key} equals the old ${old}`);
  }
  // interfaces (10), m1bInterfaces (ContextSource, AgentHostAdmin,
  // SessionFactory, HarnessRoot), methodNames (10).
  t.is(folded, 24);
  t.deepEqual(after.exports, before.exports, 'interfaces.js exports');
});

test("the gateway's key and method sets are identical", t => {
  const after = guardSnapshot();
  t.deepEqual(after.vocabulary, before.vocabulary);
  t.deepEqual(after.vocabulary.skipped, []);
});

test('each guard module answers the same objects as interfaces.js', t => {
  for (const [label, module] of Object.entries({ base, session, factory })) {
    for (const table of /** @type {const} */ ([
      'shapes',
      'interfaces',
      'methodNames',
      'texts',
      'textOf',
    ])) {
      const own = /** @type {Record<string, unknown>} */ (module[table]);
      const all = /** @type {Record<string, unknown>} */ (full[table]);
      for (const name of Object.keys(own)) {
        t.is(own[name], all[name], `${label}.${table}.${name}`);
      }
    }
  }
  // The chain: each module's tables hold the module below it.
  for (const [lower, upper] of [
    [base, session],
    [session, factory],
  ]) {
    for (const table of /** @type {const} */ ([
      'shapes',
      'interfaces',
      'texts',
    ])) {
      for (const name of Object.keys(lower[table])) {
        t.true(name in upper[table], `${table}.${name} reaches up`);
      }
    }
  }
  t.is(full.m2Interfaces.Session, full.interfaces.Session);
  t.is(full.m1bInterfaces.HarnessRoot, full.interfaces.HarnessRoot);
  t.is(full.m1bShapes.StagedText, base.shapes.StagedText);
});

/**
 * Guest modules under `dir`, relative to the guest root.
 * @param {string} dir
 * @returns {string[]}
 */
const guestFiles = dir =>
  readdirSync(path.join(guestRoot, dir), { withFileTypes: true }).flatMap(
    entry =>
      entry.isDirectory()
        ? guestFiles(path.join(dir, entry.name))
        : entry.name.endsWith('.js')
          ? [path.join(dir, entry.name)]
          : [],
  );

const TABLES = ['shapes', 'interfaces', 'methodNames', 'texts', 'textOf'];
/** @type {Record<string, any>} */
const guardModules = { base, session, factory };

/**
 * The guard-module import of a guest module, if any: the module and the
 * imported names with their local names, from the source without comments
 * (comments name tables too, `interfaces.js`; only code reads them).
 * @param {string} file
 */
const guardImportOf = file => {
  const source = readFileSync(path.join(guestRoot, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const found = source.match(
    /import \{([^}]*)\} from '[./]*(?:lib\/)?guards\/(base|session|factory)\.js';/,
  );
  if (found === null) return undefined;
  const specs = found[1]
    .split(',')
    .map(spec => spec.trim())
    .filter(spec => spec !== '')
    .map(spec => {
      const [imported, local = imported] = spec.split(/\s+as\s+/);
      return { imported, local };
    });
  return { source, level: found[2], specs };
};

test('every name a guest module reads from a guard table is in that table', t => {
  let checked = 0;
  for (const file of guestFiles('.')) {
    const found = guardImportOf(file);
    if (found !== undefined) {
      const module = guardModules[found.level];
      for (const { imported, local } of found.specs) {
        t.true(imported in module, `${file}: ${imported} is exported`);
        const reads = TABLES.includes(imported)
          ? found.source.matchAll(
              new RegExp(`(?<![\\w.$-])${local}\\.([A-Za-z_$][\\w$]*)`, 'g'),
            )
          : [];
        for (const [, name] of reads) {
          checked += 1;
          t.true(
            name in module[imported],
            `${file}: ${local}.${name} is in guards/${found.level}.js`,
          );
        }
      }
    }
  }
  t.true(checked > 100, `${checked} reads checked`);
});

test('no vat program bundles lib/interfaces.js', async t => {
  const entries = [
    'exec/main.js',
    'session/main.js',
    'factory/main.js',
    'factory/standin-session.js',
    'factory/standin-exec.js',
  ];
  const bundles = await Promise.all(
    entries.map(entry => bundleGuest(path.join(guestRoot, entry))),
  );
  for (const [index, { modules }] of bundles.entries()) {
    t.false(modules.includes('lib/interfaces.js'), entries[index]);
  }
});
