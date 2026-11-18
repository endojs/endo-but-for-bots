// @ts-check
// INT-M5: M3's gateway admits a method only if its name is in the vocabulary
// (m3-interfaces.md 4.4 rule 4a); the vocabulary loads every
// `guest/lib/interfaces-m*.js` by file name. This checks that both M5
// contract files load there and that every M5 method a page may call is
// admitted (m5-interfaces.md 9.1 "Not hotspots": the key-guard vocabulary).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { harnessNames } from '../../resources/agent-host/impl/gateway/vocabulary.js';
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { m5MethodNames } from '../../guest/lib/interfaces-m5.js';
import { m5FactoryMethodNames } from '../../guest/lib/interfaces-m5-factory.js';
/* eslint-enable import/no-relative-packages */

test("INT-M5: the gateway's vocabulary admits M5's method names", t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const { keys, methods } = harnessNames({ log: e => events.push(e) });
  t.deepEqual(
    events.filter(e => e.event === 'vocabulary-skip'),
    [],
    'interfaces-m5.js and interfaces-m5-factory.js (and every interfaces-m*.js) load',
  );
  for (const table of [m5MethodNames, m5FactoryMethodNames]) {
    for (const [name, list] of Object.entries(table)) {
      for (const method of list) {
        t.true(methods.has(method), `${name}.${method} is admitted`);
      }
    }
  }
  t.true(keys.size > 0);
});
