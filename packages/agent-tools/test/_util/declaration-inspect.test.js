// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  listDeclaredTypeMembers,
  listDeclaredTypeNames,
} from './declaration-inspect.js';

const NESTED_FIXTURE = `
type Outer = {
  a: string;
  nested: {
    x: string;
    y: string;
  };
  b: () => void;
};
type Other = string | number;
`;

test('listDeclaredTypeNames lists every top-level type alias', t => {
  t.deepEqual(listDeclaredTypeNames(NESTED_FIXTURE), ['Outer', 'Other']);
});

test('listDeclaredTypeMembers returns only the alias own top-level members', t => {
  // A multiline nested object type's own properties (`x`, `y`) must not leak
  // into the outer alias's member list; only `a`, `nested`, and `b` are
  // immediate members of `Outer`.
  t.deepEqual(listDeclaredTypeMembers(NESTED_FIXTURE, 'Outer'), [
    'a',
    'nested',
    'b',
  ]);
});

test('listDeclaredTypeMembers rejects a missing alias', t => {
  t.throws(() => listDeclaredTypeMembers(NESTED_FIXTURE, 'Missing'), {
    message: /no type alias named Missing/,
  });
});

test('listDeclaredTypeMembers rejects a non-object alias', t => {
  t.throws(() => listDeclaredTypeMembers(NESTED_FIXTURE, 'Other'), {
    message: /Other is not an object type/,
  });
});

test('listDeclaredTypeMembers reports only object-literal operands of an intersection', t => {
  const intersection = `
type Base = {
  inherited: string;
};
type Combined = Base & {
  own: string;
};
`;
  t.deepEqual(listDeclaredTypeMembers(intersection, 'Combined'), ['own']);
});

test('listDeclaredTypeMembers rejects an unsupported member form', t => {
  const indexed = `
type Indexed = {
  [key: string]: string;
};
`;
  t.throws(() => listDeclaredTypeMembers(indexed, 'Indexed'), {
    message: /unsupported member kind on type alias Indexed/,
  });
});
