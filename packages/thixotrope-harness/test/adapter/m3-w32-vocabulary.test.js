// @ts-check
// M3 W3.2: the gateway's key vocabulary (resources/agent-host/impl/gateway/
// vocabulary.js; designs/m3-interfaces.md 4.4 rule 4 and 6.3). Node only.
import '../unit/_m1a-prelude.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { m3Shapes } from '../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import {
  collectRecordKeys,
  harnessVocabulary,
} from '../../resources/agent-host/impl/gateway/vocabulary.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { M } = /** @type {GuestGlobals} */ (globalThis);

test('records, arrays and match payloads give their keys', t => {
  const keys = collectRecordKeys([
    M.splitRecord(
      { alpha: M.string() },
      { beta: M.arrayOf(M.splitRecord({ gamma: M.number() })) },
    ),
    M.or(M.splitRecord({ delta: M.any() }), M.undefined()),
    harden({ epsilon: harden([harden({ zeta: 1 })]) }),
  ]);
  for (const key of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    t.true(keys.has(key), key);
  }
});

test('interface guards give their argument patterns, not their names', t => {
  const iface = M.interface('Widget', {
    paint: M.call(M.splitRecord({ colour: M.string() }))
      .optional(M.splitRecord({ finish: M.string() }))
      .returns(M.splitRecord({ painted: M.boolean() })),
    wait: M.callWhen(M.await(M.splitRecord({ awaited: M.number() }))).returns(),
    spread: M.call()
      .rest(M.arrayOf(M.splitRecord({ rested: M.string() })))
      .returns(),
  });
  const keys = collectRecordKeys([iface]);
  for (const key of ['colour', 'finish', 'painted', 'awaited', 'rested']) {
    t.true(keys.has(key), key);
  }
  // Neither the guard's own payload keys nor its method names.
  for (const key of [
    'interfaceName',
    'methodGuards',
    'paint',
    'wait',
    'spread',
    'callKind',
    'argGuards',
    'returnGuard',
    'argGuard',
  ]) {
    t.false(keys.has(key), key);
  }
});

test('the harness vocabulary has the M2 tables and interfaces-m3.js', t => {
  /** @type {Record<string, unknown>[]} */
  const logged = [];
  const started = performance.now();
  const keys = harnessVocabulary({ log: event => logged.push(event) });
  const ms = performance.now() - started;
  t.log(`vocabulary: ${keys.size} keys in ${ms.toFixed(1)} ms`);
  // M2 shapes (CreateOptions, Submission) and M3's GatewayConfig.
  for (const key of [
    'requestId',
    'operator',
    'trustedProxies',
    'publicOrigin',
  ]) {
    t.true(keys.has(key), key);
  }
  // Every key of a GatewayConfig sample is admitted.
  const configKeys = collectRecordKeys([m3Shapes.GatewayConfig]);
  for (const key of configKeys) t.true(keys.has(key), key);
  t.false(keys.has('inventedKey0'));
  t.false(keys.has('methodGuards'));
  t.deepEqual(
    logged.filter(e => e.event === 'vocabulary-skip'),
    [],
    'every interfaces-m*.js of this lane exports vocabularyShapes',
  );
});

test('a glob over guestLibDir: skipped files are logged, others admitted', t => {
  const dir = mkdtempSync(join(tmpdir(), 'thix-m3-vocab-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const prelude = 'const { M } = globalThis;';
  writeFileSync(
    join(dir, 'interfaces-m8.js'),
    `${prelude}
export const vocabularyShapes = () => harden([
  M.interface('Fixture', {
    put: M.call(M.splitRecord({ fixtureArgKey: M.string() })).returns(),
  }),
  M.splitRecord({ fixtureShapeKey: M.number() }),
]);
`,
  );
  writeFileSync(
    join(dir, 'interfaces-m9.js'),
    `${prelude}\nexport const notVocabulary = M.splitRecord({ missingKey: M.string() });\n`,
  );
  writeFileSync(
    join(dir, 'interfaces-m9b.js'),
    `throw Error('fixture load failure');\n`,
  );
  writeFileSync(
    join(dir, 'interfaces-m9c.js'),
    `export const vocabularyShapes = () => { throw Error('fixture call failure'); };\n`,
  );
  writeFileSync(
    join(dir, 'unrelated.js'),
    `export const vocabularyShapes = () => harden([harden({ unrelatedKey: 1 })]);\n`,
  );
  /** @type {any[]} */
  const logged = [];
  const keys = harnessVocabulary({
    guestLibDir: dir,
    log: event => logged.push(event),
  });
  t.true(keys.has('fixtureArgKey'));
  t.true(keys.has('fixtureShapeKey'));
  t.false(keys.has('missingKey'));
  t.false(keys.has('unrelatedKey'));
  t.true(keys.has('requestId'), 'interfaces.js tables are always read');
  t.false(keys.has('trustedProxies'), 'only guestLibDir files are globbed');
  const skipped = logged.filter(e => e.event === 'vocabulary-skip');
  t.deepEqual(
    skipped.map(e => e.file),
    ['interfaces-m9.js', 'interfaces-m9b.js', 'interfaces-m9c.js'],
  );
  t.regex(skipped[1].error, /fixture load failure/);
  t.regex(skipped[2].error, /fixture call failure/);
  t.truthy(pathToFileURL(dir));
});
