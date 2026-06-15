// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeCap,
  capLeq,
  modeLeq,
  capsSubset,
  subsetViolation,
  READ_ONLY,
  READ_WRITE,
} from '../src/backend/caps.js';

test('mode lattice: read-only attenuates read-write, never the reverse', t => {
  t.true(modeLeq(READ_ONLY, READ_WRITE));
  t.true(modeLeq(READ_ONLY, READ_ONLY));
  t.true(modeLeq(READ_WRITE, READ_WRITE));
  t.false(modeLeq(READ_WRITE, READ_ONLY));
});

test('capLeq requires same name and kind, with mode attenuation', t => {
  const rw = makeCap({ name: 'git', kind: 'git', mode: READ_WRITE });
  const ro = makeCap({ name: 'git', kind: 'git', mode: READ_ONLY });
  t.true(capLeq(ro, rw));
  t.false(capLeq(rw, ro));
  const other = makeCap({ name: 'git', kind: 'workspace', mode: READ_ONLY });
  t.false(capLeq(other, rw));
});

test('capsSubset accepts an attenuated selection', t => {
  const parent = [
    makeCap({ name: 'git', kind: 'git', mode: READ_WRITE }),
    makeCap({ name: 'workspace', kind: 'workspace', mode: READ_ONLY }),
  ];
  t.true(
    capsSubset(
      [makeCap({ name: 'git', kind: 'git', mode: READ_ONLY })],
      parent,
    ),
  );
  t.is(
    subsetViolation(
      [makeCap({ name: 'git', kind: 'git', mode: READ_ONLY })],
      parent,
    ),
    undefined,
  );
});

test('subsetViolation rejects upgrades and unheld caps', t => {
  const parent = [
    makeCap({ name: 'git', kind: 'git', mode: READ_WRITE }),
    makeCap({ name: 'workspace', kind: 'workspace', mode: READ_ONLY }),
  ];
  t.regex(
    String(
      subsetViolation(
        [makeCap({ name: 'workspace', kind: 'workspace', mode: READ_WRITE })],
        parent,
      ),
    ),
    /cannot upgrade/,
  );
  t.regex(
    String(subsetViolation([makeCap({ name: 'net', kind: 'net' })], parent)),
    /not held/,
  );
});

test('makeCap rejects bad input', t => {
  t.throws(() => makeCap({ name: '', kind: 'git' }), { message: /non-empty/ });
  t.throws(() => makeCap({ name: 'g', kind: 'git', mode: 'bogus' }), {
    message: /mode must be/,
  });
});
