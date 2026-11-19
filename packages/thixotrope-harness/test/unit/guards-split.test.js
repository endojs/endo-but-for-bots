// @ts-check
/**
 * X1: the interface tables split per vat program (`guest/lib/guards/*.js`,
 * the chain base < session < factory < `interfaces.js`) and the M2 fold
 * (m2-interfaces.md 1.3); F2: the fold of M5's tables and the removal of the
 * M1b and M2 views (HR-SYN-1). Proof of no behaviour change:
 * - every guard, shape, method list and fixed text deep-equals its snapshot
 *   from before the split (`test/fixtures/guard-snapshot-before-x1.json`)
 *   or, for the M5 texts and names that snapshot lacked, from before the
 *   fold (`guard-snapshot-before-fold.json`), re-keyed by the committed map
 *   `test/fixtures/guard-fold-map.json`; every before entry no folded entry
 *   carries is listed there with the reason; an entry added since (the
 *   cross-lane seam unit WX.1) is listed in the map's `added` with the
 *   reason, and has no before entry;
 * - the gateway's key and method sets are the before sets plus the map's
 *   `vocabularyAdded` (WX.1's one re-pin);
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

/** @type {{ entries: Record<string, string> }} */
const beforeFold = JSON.parse(
  readFileSync(
    path.join(harness, 'test/fixtures/guard-snapshot-before-fold.json'),
    'utf8',
  ),
);
/**
 * The fold's rename map (F2, HR-SYN-1; it includes X1's fold of the ten
 * interfaces M2 extends into `interfaces`).
 * @type {{
 *   renamed: Record<string, string>,
 *   removed: Record<string, string>,
 *   changed: Record<string, string>,
 *   exportsRemoved: string[],
 *   exportsAdded: string[],
 *   added: Record<string, string>,
 *   vocabularyAdded: { keys: string[], methods: string[] },
 * }}
 */
const foldMap = JSON.parse(
  readFileSync(path.join(harness, 'test/fixtures/guard-fold-map.json'), 'utf8'),
);

test('every guard, shape, method list and text equals its snapshot from before the split and the fold, re-keyed by the fold map', t => {
  const after = guardSnapshot();
  /** @type {Record<string, string>} */
  const old = { ...before.entries, ...beforeFold.entries };
  const carried = new Set();
  for (const [key, digest] of Object.entries(after.entries)) {
    const from = foldMap.renamed[key] ?? key;
    if (key in foldMap.added) {
      t.false(from in old, `added ${key} has no before entry`);
    } else {
      t.true(from in old, `${key}: ${from} is a before entry, or added`);
      if (key in foldMap.changed) {
        t.not(digest, old[from], `${key} changed: ${foldMap.changed[key]}`);
      } else {
        t.is(digest, old[from], `${key} equals the old ${from}`);
      }
      carried.add(from);
    }
  }
  // Every before entry is carried by a folded one or removed with a reason.
  for (const key of Object.keys(old)) {
    t.true(
      carried.has(key) !== key in foldMap.removed,
      `${key}: carried or removed, not both`,
    );
  }
  for (const key of Object.keys(foldMap.removed)) {
    t.true(key in old, `removed ${key} is a before entry`);
  }
  for (const [key, reason] of Object.entries(foldMap.added)) {
    t.true(key in after.entries, `added ${key} is an entry`);
    t.true(reason.length > 0, `added ${key}: a reason`);
  }
  t.deepEqual(
    after.exports,
    [
      ...before.exports.filter(name => !foldMap.exportsRemoved.includes(name)),
      ...foldMap.exportsAdded,
    ].sort(),
    'interfaces.js exports',
  );
});

test("the gateway's key and method sets are the before sets plus WX.1's", t => {
  const after = guardSnapshot();
  const { keys, methods } = foldMap.vocabularyAdded;
  for (const key of keys) t.false(before.vocabulary.keys.includes(key), key);
  for (const name of methods) {
    t.false(before.vocabulary.methods.includes(name), name);
  }
  t.deepEqual(after.vocabulary, {
    keys: [...before.vocabulary.keys, ...keys].sort(),
    methods: [...before.vocabulary.methods, ...methods].sort(),
    skipped: [],
  });
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
  t.is(full.interfaces.ExecScope, base.interfaces.ExecScope);
  t.is(full.interfaces.Session, session.interfaces.Session);
  t.is(full.interfaces.Preset, factory.interfaces.Preset);
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
