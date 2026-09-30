// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  isValidName,
  isPetName,
  isSpecialName,
  isName,
  assertPetName,
  assertSpecialName,
  assertName,
  assertEdgeName,
  assertNames,
  assertPetNames,
  assertNamePath,
  assertPetNamePath,
  namePathFrom,
  petNamePathFrom,
} from '../src/pet-name.js';

// --- isValidName ---

test('isValidName accepts simple names', t => {
  t.true(isValidName('hello'));
  t.true(isValidName('my-project'));
  t.true(isValidName('a'));
});

test('isValidName rejects empty string', t => {
  t.false(isValidName(''));
});

test('isValidName rejects names with slash', t => {
  t.false(isValidName('a/b'));
});

test('isValidName rejects names with null byte', t => {
  t.false(isValidName('a\0b'));
});

test('isValidName rejects names with @', t => {
  t.false(isValidName('@host'));
});

test('isValidName rejects . and ..', t => {
  t.false(isValidName('.'));
  t.false(isValidName('..'));
});

test('isValidName rejects names over 255 chars', t => {
  t.false(isValidName('a'.repeat(256)));
  t.true(isValidName('a'.repeat(255)));
});

test('isValidName rejects non-string', t => {
  t.false(isValidName(/** @type {any} */ (42)));
  t.false(isValidName(/** @type {any} */ (undefined)));
});

// --- isPetName / isSpecialName / isName ---

test('isPetName is alias for isValidName', t => {
  t.true(isPetName('hello'));
  t.false(isPetName('@special'));
});

test('isSpecialName accepts valid special names', t => {
  t.true(isSpecialName('@self'));
  t.true(isSpecialName('@host'));
  t.true(isSpecialName('@agent'));
  t.true(isSpecialName('@mail'));
});

test('isSpecialName rejects invalid patterns', t => {
  t.false(isSpecialName('notspecial'));
  t.false(isSpecialName('@'));
  t.false(isSpecialName('@A'));
  t.false(isSpecialName('@1start'));
});

test('isName accepts both pet names and special names', t => {
  t.true(isName('hello'));
  t.true(isName('@self'));
  t.false(isName(''));
  t.false(isName('/'));
});

// --- assert functions ---

test('assertPetName accepts valid pet name', t => {
  t.notThrows(() => assertPetName('my-thing'));
});

test('assertPetName rejects invalid', t => {
  t.throws(() => assertPetName('@special'), { message: /Invalid pet name/ });
  t.throws(() => assertPetName(''), { message: /Invalid pet name/ });
});

test('assertSpecialName accepts valid', t => {
  t.notThrows(() => assertSpecialName('@self'));
});

test('assertSpecialName rejects invalid', t => {
  t.throws(() => assertSpecialName('notspecial'), {
    message: /Invalid special name/,
  });
});

test('assertName accepts both types', t => {
  t.notThrows(() => assertName('hello'));
  t.notThrows(() => assertName('@self'));
});

test('assertName rejects invalid', t => {
  t.throws(() => assertName(''), { message: /Invalid name/ });
  t.throws(() => assertName('/path'), { message: /Invalid name/ });
});

test('assertEdgeName accepts both types', t => {
  t.notThrows(() => assertEdgeName('hello'));
  t.notThrows(() => assertEdgeName('@self'));
});

test('assertEdgeName rejects invalid', t => {
  t.throws(() => assertEdgeName(''), { message: /Invalid edge name/ });
});

test('assertNames validates array of names', t => {
  t.notThrows(() => assertNames(['a', 'b', '@self']));
  t.throws(() => assertNames(['a', '']), { message: /Invalid name/ });
});

test('assertPetNames validates array of pet names', t => {
  t.notThrows(() => assertPetNames(['a', 'b']));
  t.throws(() => assertPetNames(['@self']), { message: /Invalid pet name/ });
});

// --- assertNamePath ---

test('assertNamePath accepts valid path', t => {
  t.notThrows(() => assertNamePath(['a']));
  t.notThrows(() => assertNamePath(['a', 'b', 'c']));
  t.notThrows(() => assertNamePath(['@self', 'child']));
});

test('assertNamePath rejects empty array', t => {
  t.throws(() => assertNamePath([]), { message: /Invalid name path/ });
});

test('assertNamePath rejects non-array', t => {
  t.throws(() => assertNamePath(/** @type {any} */ ('not-array')), {
    message: /Invalid name path/,
  });
});

// --- assertPetNamePath ---

test('assertPetNamePath returns structured result', t => {
  const result = assertPetNamePath(['a', 'b', 'c']);
  t.deepEqual(result.namePath, ['a', 'b', 'c']);
  t.deepEqual(result.prefixPath, ['a', 'b']);
  t.is(result.petName, 'c');
});

test('assertPetNamePath single element', t => {
  const result = assertPetNamePath(['x']);
  t.deepEqual(result.namePath, ['x']);
  t.deepEqual(result.prefixPath, []);
  t.is(result.petName, 'x');
});

test('assertPetNamePath rejects non-array', t => {
  t.throws(() => assertPetNamePath(/** @type {any} */ ('not-array')), {
    message: /Invalid name path/,
  });
});

test('assertPetNamePath rejects empty array', t => {
  t.throws(() => assertPetNamePath([]), { message: /Invalid name path/ });
});

test('assertPetNamePath rejects special name at end', t => {
  t.throws(() => assertPetNamePath(['@self']), {
    message: /Invalid pet name/,
  });
});

test('assertPetNamePath allows special name in prefix', t => {
  const result = assertPetNamePath(['@self', 'child']);
  t.is(result.petName, 'child');
});

// --- namePathFrom ---

test('namePathFrom rejects a bare string with a retry hint', t => {
  t.throws(() => namePathFrom('hello'), {
    instanceOf: TypeError,
    message: /a string is not a pet-name path.*\["hello"\]/,
  });
  t.throws(() => namePathFrom('dir/name'), {
    instanceOf: TypeError,
    message: /never split on a delimiter.*\["directory","name"\]$/,
  });
});

test('namePathFrom hints only with an array the validator accepts', t => {
  for (const value of ['dir/name', '', 'a@b', 'a\0b']) {
    const error = t.throws(() => namePathFrom(value), {
      instanceOf: TypeError,
    });
    t.notRegex(error.message, /for example \[[^\]]*\] or /);
    t.regex(error.message, /\["directory","name"\]$/);
  }
});

test('namePathFrom rejects values that are neither string nor array', t => {
  for (const value of [undefined, null, 42, {}]) {
    t.throws(() => namePathFrom(value), { message: /Invalid/ });
  }
});

test('namePathFrom passes through array', t => {
  const result = namePathFrom(['a', 'b']);
  t.deepEqual(result, ['a', 'b']);
});

test('namePathFrom validates', t => {
  t.throws(() => namePathFrom(''), { message: /Invalid pet-name path/ });
  t.throws(() => namePathFrom([]), { message: /Invalid/ });
  t.throws(() => namePathFrom(['a/b']), { message: /Invalid name/ });
  t.throws(() => namePathFrom(['']), { message: /Invalid name/ });
});

// --- petNamePathFrom ---

test('petNamePathFrom returns structured result for a one-segment path', t => {
  const result = petNamePathFrom(['hello']);
  t.deepEqual(result.namePath, ['hello']);
  t.deepEqual(result.prefixPath, []);
  t.is(result.petName, 'hello');
});

test('petNamePathFrom rejects a bare string', t => {
  t.throws(() => petNamePathFrom('hello'), {
    instanceOf: TypeError,
    message: /Invalid pet-name path "hello"/,
  });
});

test('petNamePathFrom coerces a path and returns structured result', t => {
  const result = petNamePathFrom(['a', 'b', 'c']);
  t.deepEqual(result.namePath, ['a', 'b', 'c']);
  t.deepEqual(result.prefixPath, ['a', 'b']);
  t.is(result.petName, 'c');
});

test('petNamePathFrom allows a special name in the prefix', t => {
  t.is(petNamePathFrom(['@self', 'child']).petName, 'child');
});

test('petNamePathFrom rejects a special name leaf', t => {
  t.throws(() => petNamePathFrom(['@self']), { message: /Invalid pet name/ });
  t.throws(() => petNamePathFrom(['a', '@self']), {
    message: /Invalid pet name/,
  });
});

test('petNamePathFrom rejects an empty path', t => {
  t.throws(() => petNamePathFrom([]), { message: /Invalid name path/ });
});

// --- properties of namePathFrom and petNamePathFrom ---

// Any string, including ones containing `/`, `@`, `\0`, and lone surrogates.
const anyStringArb = fc.string({ unit: 'binary', maxLength: 300 });

const petNameArb = fc
  .string({ unit: 'binary', minLength: 1, maxLength: 64 })
  .filter(isPetName);

const specialNameArb = fc.stringMatching(/^@[a-z][a-z0-9-]{0,127}$/);

const nameArb = fc.oneof(petNameArb, specialNameArb);

// A string that no path segment may be, whatever else surrounds it.
const invalidNameArb = fc.oneof(
  fc.constantFrom('', '.', '..'),
  fc
    .tuple(anyStringArb, fc.constantFrom('/', '\0'), anyStringArb)
    .map(([before, bad, after]) => `${before}${bad}${after}`),
  fc.string({ minLength: 256, maxLength: 300 }).filter(s => !s.includes('@')),
);

test('namePathFrom refuses every string, whatever its content', t => {
  fc.assert(
    fc.property(anyStringArb, s => {
      const error = t.throws(() => namePathFrom(s), { instanceOf: TypeError });
      t.regex(error.message, /\["directory","name"\]$/);
      // The one-segment suggestion appears exactly when it would be valid.
      t.is(
        error.message.includes(`for example ${JSON.stringify([s])} or `),
        isName(s),
      );
    }),
  );
});

test('namePathFrom passes every array of valid names through unchanged', t => {
  fc.assert(
    fc.property(fc.array(nameArb, { minLength: 1, maxLength: 8 }), path => {
      const copy = [...path];
      const result = namePathFrom(path);
      t.is(result, path);
      t.deepEqual(result, copy);
    }),
  );
});

test('namePathFrom refuses an array with any invalid segment', t => {
  fc.assert(
    fc.property(
      fc.array(nameArb, { maxLength: 4 }),
      invalidNameArb,
      fc.array(nameArb, { maxLength: 4 }),
      (before, bad, after) => {
        t.throws(() => namePathFrom([...before, bad, ...after]), {
          message: /Invalid name/,
        });
      },
    ),
  );
});

test('petNamePathFrom decomposes every pet-name path into prefix and leaf', t => {
  fc.assert(
    fc.property(
      fc.array(nameArb, { maxLength: 8 }),
      petNameArb,
      (prefix, leaf) => {
        const path = [...prefix, leaf];
        const { namePath, prefixPath, petName } = petNamePathFrom(path);
        t.is(namePath, path);
        t.deepEqual(prefixPath, prefix);
        t.is(petName, leaf);
        t.deepEqual([...prefixPath, petName], path);
      },
    ),
  );
});

test('petNamePathFrom refuses a special-name leaf and every string', t => {
  fc.assert(
    fc.property(
      fc.array(nameArb, { maxLength: 8 }),
      specialNameArb,
      (prefix, leaf) => {
        t.throws(() => petNamePathFrom([...prefix, leaf]), {
          message: /Invalid pet name/,
        });
      },
    ),
  );
  fc.assert(
    fc.property(anyStringArb, s => {
      t.throws(() => petNamePathFrom(s), { instanceOf: TypeError });
    }),
  );
});
