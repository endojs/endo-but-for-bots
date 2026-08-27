// @ts-check
import '@endo/init/debug.js';

import test from 'ava';
import { M, mustMatch } from '@endo/patterns';

import {
  collectFormValues,
  fieldKind,
  initialFormValues,
} from '@endo/spaces-util/form-fields.js';

// The field shape a deploy chart's approval ask actually sends.
const APPROVAL_FIELDS = [
  { name: 'approved', label: 'Apply this release?', pattern: M.boolean() },
  { name: 'note', label: 'Note', pattern: M.string(), default: '' },
];

test('a boolean pattern is recognised without the chart opting in', t => {
  t.is(fieldKind({ name: 'approved', pattern: M.boolean() }), 'boolean');
});

test('a boolean pattern is still recognised if its tag was stripped', t => {
  // What a `match:kind` CopyTagged degrades to if it passes through anything
  // that copies structurally and drops symbol keys. Rendering text there means
  // the UI offers a control the daemon will refuse on submit.
  t.is(fieldKind({ name: 'approved', pattern: { payload: 'boolean' } }), 'boolean');
});

test('an untagged pattern with more than a payload is not swallowed', t => {
  t.is(
    fieldKind({ name: 'x', pattern: { payload: 'boolean', extra: 1 } }),
    'text',
  );
});

test('every other field stays text', t => {
  t.is(fieldKind({ name: 'note', pattern: M.string() }), 'text');
  t.is(fieldKind({ name: 'n', pattern: M.number() }), 'text');
  t.is(fieldKind({ name: 'plain' }), 'text');
  t.is(fieldKind({ name: 'odd', pattern: 'not-a-pattern' }), 'text');
  t.is(fieldKind({ name: 'null', pattern: null }), 'text');
});

test('a boolean field starts false unless it defaults to true', t => {
  t.deepEqual(initialFormValues(APPROVAL_FIELDS), {
    approved: false,
    note: '',
  });
  t.deepEqual(
    initialFormValues([
      { name: 'approved', pattern: M.boolean(), default: true },
    ]),
    { approved: true },
  );
});

test('a boolean field submits a real boolean, not a string', t => {
  const submitted = collectFormValues(APPROVAL_FIELDS, {
    approved: true,
    note: 'looks good',
  });
  t.is(submitted.approved, true);
  t.is(submitted.note, 'looks good');
});

test('an unchecked box submits false rather than an empty string', t => {
  // The old collection did `values[name] || ''`, which turned `false` into ''
  // — so a decline was as unrepresentable as an approval.
  const submitted = collectFormValues(APPROVAL_FIELDS, {
    approved: false,
    note: '',
  });
  t.is(submitted.approved, false);
  t.not(submitted.approved, '');
});

test('a missing boolean answer is false, and a missing text answer is empty', t => {
  t.deepEqual(collectFormValues(APPROVAL_FIELDS, {}), {
    approved: false,
    note: '',
  });
});

test('submitted values satisfy the patterns the daemon checks on submit', t => {
  // `mail.js` runs `mustMatch(value, pattern)` over every field before it
  // resolves the form; this is that gate.
  for (const answer of [true, false]) {
    const submitted = collectFormValues(APPROVAL_FIELDS, {
      approved: answer,
      note: 'n',
    });
    for (const { name, pattern } of APPROVAL_FIELDS) {
      t.notThrows(
        () => mustMatch(submitted[name], pattern, name),
        `${name}=${String(submitted[name])} must match its pattern`,
      );
    }
  }
});

test('the old string-only collection would have failed that gate', t => {
  // Regression guard: this is what the UI used to send.
  t.throws(() => mustMatch('true', M.boolean(), 'approved'));
  t.throws(() => mustMatch('', M.boolean(), 'approved'));
});
