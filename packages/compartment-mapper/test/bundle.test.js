import 'ses';
import fs from 'fs';
import url from 'url';
import test from 'ava';
import { makeScript } from '../script.js';
import { makeFunctor } from '../functor.js';
import { makeArchive } from '../archive.js';
import { parseArchive } from '../import-archive.js';
import { makeReadPowers } from '../node-powers.js';
import { moduleify } from './scaffold.js';

const fixture = new URL(
  'fixtures-0/node_modules/bundle/main.js',
  import.meta.url,
).toString();

const { read } = makeReadPowers({ fs, url });

const expectedLog = [
  'On the other hand,',
  'are other fingers.',
  'dependency',
  'foo',
  moduleify({
    c: 'sea',
    i: 'eye',
    q: 'cue',
    k: 'que',
    u: 'you',
    y: 'why',
  }),
  moduleify({
    c: 'sea',
    i: 'eye',
    q: 'cue',
    k: 'que',
    u: 'you',
    y: 'why',
  }),
  'fizz',
  'buzz',
  'blue',
  'qux',
  '#777',
  moduleify({
    red: '#f00',
    green: '#0f0',
    blue: '#00f',
  }),
  moduleify({
    default: {
      zzz: 1,
      fromMjs: 'foo',
    },
    fromMjs: 'foo',
    zzz: 1,
  }),
  { widdershins: 'againshins' },
];

test('bundled scripts work', async t => {
  const bundle = await makeScript(read, fixture);
  t.log(bundle);
  t.assert(!bundle.includes('file:/'));
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: { print },
    __options__: true,
  });
  compartment.evaluate(bundle);
  t.deepEqual(log, expectedLog);
});

test('equivalent archive behaves the same as bundle', async t => {
  const log = [];
  const print = entry => {
    log.push(entry);
  };

  const archive = await makeArchive(read, fixture);
  const application = await parseArchive(archive, fixture);
  await application.import({
    globals: { print },
  });
  t.deepEqual(log, expectedLog);
});

test('makeScript with useEvaluate preserves error stack trace line numbers', async t => {
  const bundle = await makeScript(read, fixture, {
    useEvaluate: true,
  });
  t.log(bundle);
  t.assert(!bundle.includes('file:/'));
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
    },
    __options__: true,
  });
  const { raise } = compartment.evaluate(bundle);
  /** @type {null | Error} */
  let error = null;
  try {
    raise();
  } catch (_error) {
    error = /** @type {Error} */ (_error);
  }
  t.assert(error);
  const stack = /** @type {string} */ (error?.stack);
  t.true(stack.includes(':4:'));
  t.true(stack.includes('bundle/main.js'));
  t.false(stack.includes('file:/.*main.js'));
});

test('makeScript with useEvaluate and sourceUrlPrefix preserves source URLs in stack traces', async t => {
  const bundle = await makeScript(read, fixture, {
    useEvaluate: true,
    sourceUrlPrefix: 'bundled-sources/.../',
  });
  t.log(bundle);
  t.assert(!bundle.includes('file:/'));
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
    },
    __options__: true,
  });
  const { raise } = compartment.evaluate(bundle);
  /** @type {null | Error} */
  let error = null;
  try {
    raise();
  } catch (_error) {
    error = /** @type {Error} */ (_error);
  }
  t.assert(error);
  const stack = /** @type {string} */ (error?.stack);
  t.log(stack);
  t.true(stack.includes(':4:'));
  t.true(stack.includes('bundled-sources/.../bundle/main.js'));
  t.false(stack.includes('file:/.*bundle/main.js'));
});

test('makeFunctor works', async t => {
  const bundle = await makeFunctor(read, fixture);
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: { print },
    __options__: true,
  });
  compartment.evaluate(bundle)();
  t.deepEqual(log, expectedLog);
});

test('makeFunctor with useEvaluate preserves error for compiled sourceUrlPrefix when sourceUrlPrefix runtime option absent', async t => {
  const bundle = await makeFunctor(read, fixture, {
    useEvaluate: true,
    sourceUrlPrefix: 'bundled-sources/.../',
  });

  t.log(bundle);
  t.assert(!bundle.includes('file:/'));

  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
    },
    __options__: true,
  });
  const { raise } = compartment.evaluate(bundle)();
  /** @type {null | Error} */
  let error = null;
  try {
    raise();
  } catch (_error) {
    error = /** @type {Error} */ (_error);
  }
  t.assert(error);
  const stack = /** @type {string} */ (error?.stack);
  t.true(stack.includes(':4:'));
  t.true(stack.includes('bundled-sources/.../bundle/main.js'));
  t.false(stack.includes('file:/.*bundle/main.js'));
});

test('makeFunctor with useEvaluate preserves error for sourceUrlPrefix runtime option', async t => {
  const bundle = await makeFunctor(read, fixture, {
    useEvaluate: true,
    sourceUrlPrefix: 'bogus',
  });

  t.log(bundle);
  t.assert(!bundle.includes('file:/'));

  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
    },
    __options__: true,
  });
  const { raise } = compartment.evaluate(bundle)({
    sourceUrlPrefix: 'bundled-sources/.../',
  });
  /** @type {null | Error} */
  let error = null;
  try {
    raise();
  } catch (_error) {
    error = /** @type {Error} */ (_error);
  }
  t.assert(error);
  const stack = /** @type {string} */ (error?.stack);
  t.true(stack.includes(':4:'));
  t.true(stack.includes('bundled-sources/.../bundle/main.js'));
  t.false(stack.includes('file:/.*bundle/main.js'));
});

test('makeFunctor with useEvaluate works', async t => {
  const bundle = await makeFunctor(read, fixture);
  t.assert(!bundle.includes('file:/'));
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
      nestedEvaluate(source) {
        return compartment.evaluate(source);
      },
    },
    __options__: true,
  });
  compartment.evaluate(`${bundle}({ evaluate: nestedEvaluate })`);
  t.deepEqual(log, expectedLog);
});

test('makeFunctor with useEvaluate and evaluate runtime option works', async t => {
  const bundle = await makeFunctor(read, fixture, {
    useEvaluate: true,
  });
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    __options__: true,
    globals: {
      print,
    },
  });
  compartment.evaluate(bundle)({
    evaluate(source) {
      return compartment.evaluate(source);
    },
  });
  t.deepEqual(log, expectedLog);
});

test('makeFunctor with useEvaluate preserves error stack trace line numbers', async t => {
  const bundle = await makeFunctor(read, fixture, {
    useEvaluate: true,
  });
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
      nestedEvaluate(source) {
        return compartment.evaluate(source);
      },
    },
    __options__: true,
  });
  t.log(bundle);
  t.assert(!bundle.includes('file:/'));
  const { raise } = compartment.evaluate(
    `(${bundle})({ evaluate: nestedEvaluate })`,
  );
  /** @type {null | Error} */
  let error = null;
  try {
    raise();
  } catch (_error) {
    error = /** @type {Error} */ (_error);
  }
  t.assert(error);
  const stack = /** @type {string} */ (error?.stack);
  t.true(stack.includes(':4:'));
  t.true(stack.includes('bundle/main.js'));
  t.false(stack.includes('file:/.*bundle/main.js'));
});

test('makeFunctor with useEvaluate and evaluate runtime option preserves stack trace line numbers', async t => {
  const bundle = await makeFunctor(read, fixture, {
    useEvaluate: true,
  });
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: {
      print,
    },
    __options__: true,
  });
  const { raise } = compartment.evaluate(bundle)({
    evaluate(source) {
      return compartment.evaluate(source);
    },
  });
  /** @type {null | Error} */
  let error = null;
  try {
    raise();
  } catch (_error) {
    error = /** @type {Error} */ (_error);
  }
  t.assert(error);
  const stack = /** @type {string} */ (error?.stack);
  t.true(stack.includes(':4:'));
  t.true(stack.includes('bundle/main.js'));
  t.false(stack.includes('file:/.*bundle/main.js'));
});

// The missing-dependency blocker for this fixture (an unresolved internal
// module recorded as a deferred error aborting the bundle at graph-sort time)
// is fixed; see the "bundle tolerates unreachable missing dependencies" and
// "bundle throws a reached missing dependency lazily" tests below. This test
// remains failing on the rest of the CJS-compat surface that the bundler's
// runtime does not yet match the importer on, e.g. binding the top-level `this`
// to `module.exports` and redefining `module.exports` via `defineProperty`.
test.failing('bundle cjs-compat', async t => {
  const cjsFixture = new URL(
    'fixtures-cjs-compat/node_modules/app/index.js',
    import.meta.url,
  ).toString();

  const bundle = await makeScript(read, cjsFixture);
  const log = [];
  const print = entry => {
    log.push(entry);
  };
  const compartment = new Compartment({
    globals: { print },
    __options__: true,
  });
  compartment.evaluate(bundle);
  t.deepEqual(log, expectedLog);
});

// A module may statically appear to require a module that cannot be resolved
// (the CommonJS parser heuristically detects the require). The compartment
// mapper records such a module as a deferred error whose error throws only if
// the module is actually evaluated. The bundler must mirror that runtime
// semantics: an unresolved module that is never reached must not abort the
// bundle, neither at bundle time nor at evaluation time.
test('bundle tolerates unreachable missing dependencies', async t => {
  const fixtureLocation = new URL(
    'fixtures-bundle-missing-dep/node_modules/unreachable-missing-dep/index.js',
    import.meta.url,
  ).toString();

  const bundle = await makeScript(read, fixtureLocation);
  const compartment = new Compartment();
  const namespace = compartment.evaluate(bundle);
  t.is(namespace.ok, true);
});

// The complementary guarantee: a missing dependency that is actually reached at
// evaluation time throws the deferred error lazily, exactly as the importer
// would, rather than failing the bundle eagerly.
test('bundle throws a reached missing dependency lazily', async t => {
  const fixtureLocation = new URL(
    'fixtures-bundle-missing-dep/node_modules/reached-missing-dep/index.js',
    import.meta.url,
  ).toString();

  // The bundle is produced without error even though a dependency is missing.
  const bundle = await makeScript(read, fixtureLocation);
  const compartment = new Compartment();
  t.throws(() => compartment.evaluate(bundle), {
    message: /Cannot find file for internal module "\.\/does-not-exist"/,
  });
});

test('bundle cjs-compat default-difficulties', async t => {
  const cjsFixture = new URL(
    'fixtures-cjs-compat/node_modules/default-difficulties/index.mjs',
    import.meta.url,
  ).toString();

  const bundle = await makeScript(read, cjsFixture);
  const compartment = new Compartment();
  const { results } = compartment.evaluate(bundle);
  const resultExports = results.map(result => {
    return Object.keys(result).sort();
  });
  t.deepEqual(resultExports, [
    ['default', 'even'],
    ['default', 'even', 'version'],
    ['__esModule', 'default', 'even', 'version'],
    ['__esModule', 'default', 'even', 'version'],
    ['default', 'even', 'version'],
    ['default', 'even'],
    ['default', 'even'],
  ]);
});
