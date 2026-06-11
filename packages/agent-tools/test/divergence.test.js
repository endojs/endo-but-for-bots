// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

/** @import { ERef } from '@endo/far' */
/** @import { InterfaceGuard, Pattern } from '@endo/patterns' */
/** @import { GitToolCapability, ToolRecord } from '../src/types.js' */

import test from 'ava';
import { Ajv } from 'ajv';
import {
  M,
  matches,
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import { E, Far } from '@endo/far';
import { GitInterface } from '@endo/exo-git';

import { makeGitTool } from '../src/git-tool.js';
import { makeTool } from '../src/tool.js';
import { prepareGuestPowers, bindCap } from './helpers/daemon-petstore.js';

/**
 * Conformance checks for hand-authored JSON Schemas and runtime guards.
 */

const ajv = new Ajv({ strict: false });

/**
 * Positional guard structure from `GitInterface`.
 *
 * @param {string} method
 */
const guardShapeFor = method => {
  const { methodGuards } = getInterfaceGuardPayload(
    /** @type {InterfaceGuard} */ (GitInterface),
  );
  const { argGuards, optionalArgGuards } = getMethodGuardPayload(
    methodGuards[method],
  );
  const optional = optionalArgGuards || [];
  return {
    requiredCount: argGuards.length,
    guards: harden([...argGuards, ...optional]),
  };
};

/**
 * Decide whether the runtime guards accept a named-args record, mapping the
 * record's keys onto positional slots by the schema's declared property order.
 *
 * @param {{requiredCount:number, guards:Pattern[]}} shape
 * @param {string[]} paramNames Declared property names, in positional order.
 * @param {Record<string, unknown>} record
 */
const guardAccepts = (shape, paramNames, record) => {
  const { requiredCount, guards } = shape;
  const allowed = new Set(paramNames.slice(0, guards.length));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  for (let i = 0; i < guards.length; i += 1) {
    const key = paramNames[i];
    // JSON has no `undefined`, so a known `name: undefined` is treated as absent.
    const present =
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] !== undefined;
    if (present) {
      if (!matches(record[key], guards[i])) return false;
    } else if (i < requiredCount) {
      return false;
    }
  }
  return true;
};

/**
 * Candidate args records covering valid and invalid shapes, keyed by abstract
 * positional slots (`slot0`/`slot1`) plus an out-of-band `extra` key. The macro
 * remaps each slot to the tool's real declared property name, so the same
 * coverage exercises every tool's named signature.
 */
const slotRecords = harden([
  {},
  { slot0: 'a-string' },
  { slot0: '' },
  { slot0: 42 },
  { slot0: 42n },
  { slot0: true },
  { slot0: null },
  { slot0: undefined },
  { slot0: {} },
  { slot0: { k: 'v' } },
  { slot0: [] },
  { slot1: 'only-second' },
  { slot0: 'a', slot1: {} },
  { slot0: 'a', slot1: { opt: 1 } },
  { slot0: 'a', slot1: 'not-a-record' },
  { slot0: 'a', slot1: 5 },
  { slot0: {}, slot1: {} },
  { slot0: 'a', extra: 'x' },
  { extra: 'x' },
  { extra: undefined },
  { slot0: undefined, slot1: undefined },
  // Open-object option records.
  { slot0: { a: 1, b: 2 } },
  { slot0: { nested: { x: 1 } } },
  { slot0: harden({ author: 'alice', oneline: true, maxCount: 10 }) },
  { slot0: 'a', slot1: { a: 1, b: 2 } },
  { slot0: 'a', slot1: { nested: { x: 1 } } },
  { slot0: 'a', slot1: harden({ track: true, startPoint: 'main' }) },
]);

/**
 * Declared property names for a tool, in positional order.
 *
 * @param {ToolRecord} tool
 * @returns {string[]}
 */
const paramNamesOf = tool =>
  Object.keys(
    /** @type {{ properties?: Record<string, unknown> }} */ (tool.parameters)
      .properties || {},
  );

/**
 * Remap an abstract slot record onto a tool's real property names. `slot0` →
 * the first declared property, `slot1` → the second; unknown slots and `extra`
 * are preserved verbatim so the out-of-band-key cases still exercise rejection.
 *
 * @param {Record<string, unknown>} slotRecord
 * @param {string[]} paramNames
 * @returns {Record<string, unknown>}
 */
const toNamedRecord = (slotRecord, paramNames) => {
  /** @type {Record<string, unknown>} */
  const named = {};
  for (const [slot, value] of Object.entries(slotRecord)) {
    const match = /^slot(\d+)$/.exec(slot);
    const key =
      match && paramNames[Number(match[1])] !== undefined
        ? paramNames[Number(match[1])]
        : slot;
    named[key] = value;
  }
  return named;
};

const gitTools = makeGitTool(
  // This test inspects schemas and guards; it never invokes the capability.
  /** @type {ERef<GitToolCapability>} */ (
    /** @type {unknown} */ (Far('InertGit', {}))
  ),
);

/**
 * For one git tool, assert its hand-authored JSON Schema and its runtime guard
 * agree on every candidate args record.
 */
const schemaGuardAgree = test.macro({
  exec(t, /** @type {ToolRecord} */ tool) {
    const shape = guardShapeFor(tool.name);
    const paramNames = paramNamesOf(tool);
    const validate = ajv.compile(tool.parameters);
    let checked = 0;
    for (const slotRecord of slotRecords) {
      const record = toNamedRecord(slotRecord, paramNames);
      const guardOk = guardAccepts(shape, paramNames, record);
      const schemaOk = validate({ ...record });
      t.is(
        schemaOk,
        guardOk,
        `${tool.name}: schema=${schemaOk} guard=${guardOk} for ${JSON.stringify(
          record,
          (_k, v) => (typeof v === 'bigint' ? `${v}n` : v),
        )}`,
      );
      checked += 1;
    }
    t.true(checked > 0);
  },
  title(_providedTitle, /** @type {ToolRecord} */ tool) {
    return `schema ⟷ guard agree for git.${tool.name}`;
  },
});

for (const tool of gitTools) {
  test(schemaGuardAgree, tool);
}

// --- bigint synthetic case ----------------------------------------------
//
// The current Git slice has no bigint args, so this covers the bigint
// guard-to-schema mapping directly.

const BIGINT_GUARD = M.bigint();
const BIGINT_SCHEMA = harden({
  type: 'string',
  pattern: '^[+-]?\\d+$',
});
const BIGINT_SCHEMA_WRONG = harden({ type: 'integer' });

test('bigint guard and string-pattern schema agree', t => {
  const validateStr = ajv.compile(BIGINT_SCHEMA);

  /** @type {Array<[unknown, unknown]>} */
  const pairs = harden([
    [5n, '5'],
    [5n, '+5'],
    [-3n, '-3'],
    [0n, '0'],
    [
      123_456_789_012_345_678_901_234_567_890n,
      '123456789012345678901234567890',
    ],
    ['x', 'x'],
    [5.5, '5.5'],
    [{}, '{}'],
    [true, 'true'],
    ['', ''],
  ]);

  for (const [guardValue, wireValue] of pairs) {
    const guardOk = matches(guardValue, BIGINT_GUARD);
    const schemaOk = validateStr(wireValue);
    t.is(
      schemaOk,
      guardOk,
      `bigint: guard(${String(guardValue)})=${guardOk} schema(${JSON.stringify(
        wireValue,
      )})=${schemaOk}`,
    );
  }

  t.true(matches(5n, BIGINT_GUARD));
  t.true(validateStr('5'));
  t.true(validateStr('+5'));
  t.true(validateStr('-3'));
  t.false(validateStr('x'));
  t.false(validateStr('5.5'));
  t.false(validateStr('{}'));
});

test('{type:integer} schema diverges from a bigint guard', t => {
  const validateInt = ajv.compile(BIGINT_SCHEMA_WRONG);

  let divergences = 0;

  {
    const schemaOk = validateInt(5);
    const guardOk = matches(5, BIGINT_GUARD);
    t.true(schemaOk, 'integer-schema accepts the JSON number 5');
    t.false(guardOk, 'bigint-guard rejects the JS number 5');
    if (schemaOk !== guardOk) divergences += 1;
  }

  {
    const schemaOk = validateInt('5');
    const guardOk = matches(5n, BIGINT_GUARD);
    t.false(schemaOk, 'integer-schema rejects the string "5"');
    t.true(guardOk, 'bigint-guard accepts 5n');
    if (schemaOk !== guardOk) divergences += 1;
  }

  t.true(
    divergences >= 1,
    'an {type:integer} schema diverges from a bigint guard',
  );
});

// --- capref args: remotable guard ⟷ petname-string schema ----------------
//
// An LLM cannot put a live object in JSON, so a capref arg crosses the wire as
// a friendly **petname string** that the invoke layer resolves to the live cap
// via the guest petstore (`E(powers).lookup`) BEFORE the guard runs. The schema
// for such an arg is therefore `{type:'string'}` (a petname), and the guard is
// `M.remotable()`; `M.arrayOf(M.remotable())` ⟷ a petname-string array. The two
// agree when the strings the schema accepts are exactly the names the petstore
// resolves to caps the guard accepts. This is the gate that will unblock git
// `add`/`restore` (#425).
//
// The behavioral round-trips bind petnames in a REAL daemon-backed guest
// petstore and resolve through the live `lookup` — never a hand-rolled `Map`.
// They fork a daemon per test, so they are `test.serial` with a `t.teardown`.

const PETNAME_SCHEMA = harden({
  type: 'string',
  description: 'petname of a capability',
});
const PETNAME_ARRAY_SCHEMA = harden({
  type: 'array',
  items: {
    type: 'string',
    description: 'petname of a capability',
  },
});

test('remotable guard ⟷ petname-string schema agree (capref)', t => {
  const validate = ajv.compile(PETNAME_SCHEMA);

  // A petname is just a friendly string; the schema accepts any string and the
  // guard accepts the live cap the petstore resolves it to.
  t.true(validate('gitReadOnly'));
  t.true(validate('endoRepo'));
  t.true(matches(Far('SomeCap', {}), M.remotable()));

  // Non-strings can never be a valid wire value for a petname.
  t.false(validate(42));
  t.false(validate({}));
  t.false(validate([]));
});

test('arrayOf(remotable) guard ⟷ petname-array schema agree (capref[])', t => {
  const validate = ajv.compile(PETNAME_ARRAY_SCHEMA);

  // An array of petnames: schema-valid, and the resolved caps match
  // arrayOf(remotable).
  t.true(validate(['endoRepo', 'gardenRepo']));
  t.true(
    matches(harden([Far('A', {}), Far('B', {})]), M.arrayOf(M.remotable())),
  );

  // Empty array: both accept (an empty arrayOf matches).
  t.true(validate([]));
  t.true(matches(harden([]), M.arrayOf(M.remotable())));

  // A mixed array with a non-string element: the schema rejects it.
  t.false(validate(['endoRepo', 42]));
});

test.serial(
  'capref resolution at the makeTool invoke boundary (round-trip)',
  async t => {
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    // Bind a formula-backed cap under a friendly petname, host-side.
    const cap = await bindCap(t, powers, 'theCounter');

    /** @type {unknown} */
    let received;
    const tool = makeTool({
      name: 'useCap',
      description: 'takes a live cap by petname',
      // `makeTool.invoke` receives a NAMED record (`{ arg0: petname }`), so the
      // advertised parameters schema is an object schema keyed by `arg0`, with
      // the petname-string schema as the `arg0` property.
      parameters: harden({
        type: 'object',
        properties: { arg0: PETNAME_SCHEMA },
        required: ['arg0'],
        additionalProperties: false,
      }),
      argGuards: [M.remotable()],
      argKinds: ['capref'],
      powers,
      execute: async args => {
        received = args.arg0;
        return 'ok';
      },
    });

    // A bound petname resolves to the live cap before `execute` sees it.
    t.is(await tool.invoke({ arg0: 'theCounter' }), 'ok');
    // The resolved value is the live cap: it answers an eventual-send the way
    // the original does (proving it is the cap, not the petname string).
    t.is(await E(/** @type {any} */ (received)).incr(), 1);
    t.is(await E(cap).incr(), 2);

    // An unbound petname fails closed before `execute` runs (the daemon
    // directory throws on an unknown name).
    await t.throwsAsync(() => tool.invoke({ arg0: 'neverBound' }), {
      message: /[Uu]nknown pet name/,
    });
  },
);

test.serial(
  'capref[] resolution at the makeTool invoke boundary (round-trip)',
  async t => {
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    const c0 = await bindCap(t, powers, 'first');
    const c1 = await bindCap(t, powers, 'second');

    /** @type {unknown} */
    let received;
    const tool = makeTool({
      name: 'useCaps',
      description: 'takes live caps by petname array',
      parameters: harden({
        type: 'object',
        properties: { arg0: PETNAME_ARRAY_SCHEMA },
        required: ['arg0'],
        additionalProperties: false,
      }),
      argGuards: [M.arrayOf(M.remotable())],
      argKinds: ['capref[]'],
      powers,
      execute: async args => {
        received = args.arg0;
        return 'ok';
      },
    });

    t.is(await tool.invoke({ arg0: ['first', 'second'] }), 'ok');
    const receivedArray = /** @type {unknown[]} */ (received);
    t.is(receivedArray.length, 2);
    // Each element is the live cap, resolved in order.
    t.is(await E(/** @type {any} */ (receivedArray[0])).incr(), 1);
    t.is(await E(/** @type {any} */ (receivedArray[1])).incr(), 1);
    t.is(await E(c0).incr(), 2);
    t.is(await E(c1).incr(), 2);

    // One unbound element fails the whole call, before `execute`.
    await t.throwsAsync(() => tool.invoke({ arg0: ['first', 'neverBound'] }), {
      message: /[Uu]nknown pet name/,
    });
  },
);

test.serial(
  'NEGATIVE CONTROL: argKinds resolves caprefs even with NO argGuards',
  async t => {
    // `argKinds` is the authority-bearing switch, so a tool that marks a capref
    // positional but supplies no `argGuards` must STILL receive the resolved
    // live cap, never the raw petname string. Before the fix, resolution lived
    // inside the `argGuards !== undefined` branch, so a guard-less capref tool
    // leaked the petname string straight to `execute`. This is the #1
    // product-risk regression this gate exists to catch.
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    const cap = await bindCap(t, powers, 'unguarded');

    /** @type {unknown} */
    let received;
    const tool = makeTool({
      name: 'unguardedCap',
      description: 'a capref arg with no runtime guard',
      parameters: harden({
        type: 'object',
        properties: { arg0: PETNAME_SCHEMA },
        required: ['arg0'],
        additionalProperties: false,
      }),
      // Deliberately NO argGuards.
      argKinds: ['capref'],
      powers,
      execute: async args => {
        received = args.arg0;
        return 'ok';
      },
    });

    t.is(await tool.invoke({ arg0: 'unguarded' }), 'ok');
    // `execute` must see the live cap, NOT the petname string.
    t.not(received, 'unguarded', 'execute did NOT receive the raw petname');
    t.is(await E(/** @type {any} */ (received)).incr(), 1);
    t.is(await E(cap).incr(), 2);

    // An unbound petname still fails closed before `execute` runs, even without
    // a guard.
    await t.throwsAsync(() => tool.invoke({ arg0: 'neverBound' }), {
      message: /[Uu]nknown pet name/,
    });
  },
);

test.serial(
  'a short argKinds defaults the trailing positional to a plain value',
  async t => {
    // A tool like `restore` marks only its leading capref positional; the
    // trailing options arg is left implicitly a plain value. A missing argKinds
    // entry must default to 'value' (NOT be misread as a capref), so the plain
    // value passes through unresolved.
    t.timeout(120_000);
    const powers = await prepareGuestPowers(t);
    const cap = await bindCap(t, powers, 'entry');

    /** @type {unknown} */
    let received;
    const tool = makeTool({
      name: 'restoreLike',
      description: 'a leading capref[] and a trailing plain options record',
      parameters: harden({
        type: 'object',
        properties: {
          arg0: PETNAME_ARRAY_SCHEMA,
          arg1: { type: 'object' },
        },
        required: ['arg0'],
        additionalProperties: false,
      }),
      argGuards: [M.arrayOf(M.remotable()), M.recordOf(M.string(), M.any())],
      // Deliberately short: only the first positional is marked.
      argKinds: ['capref[]'],
      powers,
      execute: async args => {
        received = [args.arg0, args.arg1];
        return 'ok';
      },
    });

    const options = harden({ staged: true });
    t.is(await tool.invoke({ arg0: ['entry'], arg1: options }), 'ok');
    // arg0 resolved to the live cap; arg1 passed through untouched.
    const pair = /** @type {unknown[]} */ (received);
    const resolvedCap = /** @type {unknown[]} */ (pair[0])[0];
    t.is(await E(/** @type {any} */ (resolvedCap)).incr(), 1);
    t.is(await E(cap).incr(), 2);
    t.is(pair[1], options);
  },
);

test('NEGATIVE CONTROL: a raw petname string is NOT a remotable (resolve is required)', t => {
  // If an implementation skipped resolution and handed the raw petname string
  // to the guard, the guard would reject it — a string is not a remotable. This
  // proves resolution before `mustMatch` is mandatory.
  const validate = ajv.compile(PETNAME_SCHEMA);
  t.true(validate('endoRepo'), 'schema accepts the wire petname string');
  t.false(
    matches('endoRepo', M.remotable()),
    'the guard rejects the raw petname string (resolution is mandatory)',
  );
});

test('NEGATIVE CONTROL: {type:object} schema DIVERGES from a remotable arg', t => {
  // A careless author might schema a remotable arg as {type:'object'} ("a
  // remotable is an object"). But an LLM cannot put a live object in JSON; the
  // only correct wire form is the petname string. The two schemas diverge: the
  // object schema accepts a bare {} that the (correct) petname-string schema
  // rejects.
  const validateObject = ajv.compile(harden({ type: 'object' }));
  const validatePetname = ajv.compile(PETNAME_SCHEMA);
  t.true(validateObject({}), 'object-schema accepts a bare object');
  t.false(validatePetname({}), 'petname-string schema (correct) rejects it');
});
