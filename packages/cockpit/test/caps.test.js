// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeCap,
  capLeq,
  modeLeq,
  capsSubset,
  subsetViolation,
  READ_ONLY,
  READ_WRITE,
} from '../src/backend/caps.js';

test('mode lattice: read-only attenuates read-write, never the reverse', () => {
  assert.ok(modeLeq(READ_ONLY, READ_WRITE));
  assert.ok(modeLeq(READ_ONLY, READ_ONLY));
  assert.ok(modeLeq(READ_WRITE, READ_WRITE));
  assert.ok(!modeLeq(READ_WRITE, READ_ONLY));
});

test('capLeq requires same name and kind, with mode attenuation', () => {
  const rw = makeCap({ name: 'git', kind: 'git', mode: READ_WRITE });
  const ro = makeCap({ name: 'git', kind: 'git', mode: READ_ONLY });
  assert.ok(capLeq(ro, rw));
  assert.ok(!capLeq(rw, ro));
  const other = makeCap({ name: 'git', kind: 'workspace', mode: READ_ONLY });
  assert.ok(!capLeq(other, rw));
});

test('capsSubset accepts an attenuated selection', () => {
  const parent = [
    makeCap({ name: 'git', kind: 'git', mode: READ_WRITE }),
    makeCap({ name: 'workspace', kind: 'workspace', mode: READ_ONLY }),
  ];
  assert.ok(capsSubset([makeCap({ name: 'git', kind: 'git', mode: READ_ONLY })], parent));
  assert.equal(
    subsetViolation([makeCap({ name: 'git', kind: 'git', mode: READ_ONLY })], parent),
    undefined,
  );
});

test('subsetViolation rejects upgrades and unheld caps', () => {
  const parent = [
    makeCap({ name: 'git', kind: 'git', mode: READ_WRITE }),
    makeCap({ name: 'workspace', kind: 'workspace', mode: READ_ONLY }),
  ];
  assert.match(
    String(subsetViolation([makeCap({ name: 'workspace', kind: 'workspace', mode: READ_WRITE })], parent)),
    /cannot upgrade/,
  );
  assert.match(
    String(subsetViolation([makeCap({ name: 'net', kind: 'net' })], parent)),
    /not held/,
  );
});

test('makeCap rejects bad input', () => {
  assert.throws(() => makeCap({ name: '', kind: 'git' }), /non-empty/);
  assert.throws(() => makeCap({ name: 'g', kind: 'git', mode: 'bogus' }), /mode must be/);
});
