// @ts-nocheck
// Tests for TC39 import attributes threaded through the SES loader.
// See `designs/ses-import-attributes.md`.
import test from 'ava';
import '../index.js';
import {
  EMPTY_ATTRIBUTES,
  normalizeImportAttributes,
  attributesMemoKey,
  isEmptyAttributes,
} from '../src/module-attributes.js';

lockdown();

// A virtual module source whose default export is the given value.
const valueSource = value => ({
  imports: [],
  exports: ['default'],
  execute(env) {
    env.default = value;
  },
});

// A hand-written precompiled module source whose sole default export is the
// promise produced by `import(depSpecifier, { with: attrs })`.  This exercises
// the real dynamic-import wiring ($h_import) without depending on the parser.
const dynamicImportSource = (depSpecifier, attrs) => ({
  imports: [],
  exports: ['default'],
  reexports: [],
  __syncModuleProgram__: `({ import: dynImport, onceVar, imports }) => {
    imports(new Map());
    onceVar.default(dynImport(${JSON.stringify(
      depSpecifier,
    )}, { with: ${JSON.stringify(attrs)} }));
  }`,
  __liveExportMap__: {},
  __fixedExportMap__: { default: ['default'] },
  __reexportMap__: {},
  __needsImport__: true,
  __needsImportMeta__: false,
});

// -- Normalization ---------------------------------------------------------

test('normalizeImportAttributes returns the sentinel for empty input', t => {
  t.is(normalizeImportAttributes(), EMPTY_ATTRIBUTES);
  t.is(normalizeImportAttributes({}), EMPTY_ATTRIBUTES);
  t.is(normalizeImportAttributes({ __proto__: null }), EMPTY_ATTRIBUTES);
  t.true(isEmptyAttributes(EMPTY_ATTRIBUTES));
  t.true(Object.isFrozen(EMPTY_ATTRIBUTES));
  t.is(Object.getPrototypeOf(EMPTY_ATTRIBUTES), null);
});

test('normalizeImportAttributes clones, freezes, and sorts keys', t => {
  const input = { type: 'json', charset: 'utf-8' };
  const normalized = normalizeImportAttributes(input);
  t.not(normalized, input, 'never returns the caller input');
  t.true(Object.isFrozen(normalized));
  t.is(Object.getPrototypeOf(normalized), null);
  t.deepEqual(Object.keys(normalized), ['charset', 'type'], 'keys are sorted');
  t.deepEqual({ ...input }, { type: 'json', charset: 'utf-8' }, 'input intact');
});

test('normalizeImportAttributes is order-independent under stringify', t => {
  const a = normalizeImportAttributes({ type: 'json', charset: 'utf-8' });
  const b = normalizeImportAttributes({ charset: 'utf-8', type: 'json' });
  t.not(a, b);
  t.is(JSON.stringify(a), JSON.stringify(b));
});

test('normalizeImportAttributes rejects non-string and nullish values', t => {
  t.throws(() => normalizeImportAttributes({ type: 42 }), {
    instanceOf: TypeError,
  });
  t.throws(() => normalizeImportAttributes({ type: null }), {
    instanceOf: TypeError,
  });
  t.throws(() => normalizeImportAttributes({ type: undefined }), {
    instanceOf: TypeError,
  });
  t.throws(() => normalizeImportAttributes('json'), { instanceOf: TypeError });
});

test('attributesMemoKey collapses empty to the bare specifier', t => {
  t.is(attributesMemoKey('./a.js', EMPTY_ATTRIBUTES), './a.js');
  t.is(
    attributesMemoKey('./doc.json', normalizeImportAttributes({ type: 'json' })),
    '["./doc.json",{"type":"json"}]',
  );
  // Extended keys always begin with `[`, so cannot collide with a bare
  // specifier, even one containing a NUL.
  t.not(
    attributesMemoKey('./doc.json\0x', EMPTY_ATTRIBUTES),
    attributesMemoKey('./doc.json', normalizeImportAttributes({ type: 'x' })),
  );
});

// -- Dynamic import threads attributes to the hook -------------------------

test('dynamic import threads with-clause attributes to importHook', async t => {
  const calls = [];
  const c = new Compartment({
    __options__: true,
    resolveHook: specifier => specifier,
    importHook: async (specifier, attributes) => {
      calls.push([specifier, { ...attributes }]);
      if (specifier === 'entry') {
        return { source: dynamicImportSource('./dep', { type: 'json' }) };
      }
      return { source: valueSource({ ok: attributes.type }) };
    },
  });
  const { namespace } = await c.import('entry');
  const depNamespace = await namespace.default;
  t.deepEqual(depNamespace.default, { ok: 'json' });
  t.deepEqual(calls, [
    ['entry', {}],
    ['./dep', { type: 'json' }],
  ]);
});

// -- Memo collapse and per-attribute separation ---------------------------

test('per-attribute memo separation and empty-case collapse', async t => {
  const calls = [];
  const c = new Compartment({
    __options__: true,
    resolveHook: specifier => specifier,
    importHook: async (specifier, attributes) => {
      if (specifier === 'entry') {
        return {
          source: {
            imports: [],
            exports: ['a', 'b', 'c', 'd'],
            reexports: [],
            __syncModuleProgram__: `({ import: dynImport, onceVar, imports }) => {
              imports(new Map());
              onceVar.a(dynImport('./doc.json'));
              onceVar.b(dynImport('./doc.json'));
              onceVar.c(dynImport('./doc.json', { with: { type: 'json' } }));
              onceVar.d(dynImport('./doc.json', { with: { type: 'css' } }));
            }`,
            __liveExportMap__: {},
            __fixedExportMap__: {
              a: ['a'],
              b: ['b'],
              c: ['c'],
              d: ['d'],
            },
            __reexportMap__: {},
            __needsImport__: true,
            __needsImportMeta__: false,
          },
        };
      }
      calls.push(attributesMemoKey(specifier, attributes));
      return { source: valueSource(attributes.type ?? 'plain') };
    },
  });
  const { namespace } = await c.import('entry');
  const [a, b, cc, d] = await Promise.all([
    namespace.a,
    namespace.b,
    namespace.c,
    namespace.d,
  ]);
  t.is(a.default, 'plain');
  t.is(b.default, 'plain');
  t.is(cc.default, 'json');
  t.is(d.default, 'css');
  // The two unattributed imports collapse to one memo entry (a shared exports
  // namespace); each typed import is a distinct memo entry / namespace.
  t.is(a, b, 'unattributed imports share one memo entry');
  t.not(a, cc, 'unattributed and typed are distinct memo entries');
  t.not(cc, d, 'differing types are distinct memo entries');
  // The set of memo keys the hook resolved: the legacy-collapse key plus one
  // JSON-tuple key per distinct type.
  t.deepEqual(
    [...new Set(calls)].sort(),
    [
      '["./doc.json",{"type":"css"}]',
      '["./doc.json",{"type":"json"}]',
      './doc.json',
    ].sort(),
  );
});

// -- Arity-based backward compatibility ------------------------------------

test('legacy single-arg importHook serves js and empty attributes', async t => {
  const c = new Compartment({
    __options__: true,
    resolveHook: specifier => specifier,
    importHook: async specifier => {
      if (specifier === 'entry') {
        return { source: dynamicImportSource('./dep', { type: 'js' }) };
      }
      return { source: valueSource('served') };
    },
  });
  const { namespace } = await c.import('entry');
  const depNamespace = await namespace.default;
  t.is(depNamespace.default, 'served');
});

test('legacy single-arg importHook throws the documented TypeError', async t => {
  const c = new Compartment({
    __options__: true,
    noAggregateLoadErrors: true,
    resolveHook: specifier => specifier,
    importHook: async specifier => {
      if (specifier === 'entry') {
        return { source: dynamicImportSource('./dep', { type: 'json' }) };
      }
      return { source: valueSource('unreached') };
    },
  });
  const { namespace } = await c.import('entry');
  await t.throwsAsync(namespace.default, {
    instanceOf: TypeError,
    message:
      'importHook for "./dep" does not accept attributes;\n' +
      '  request was with { type: "json" }\n' +
      '  (hook arity 1; expected 2+ to honor non-JS attributes)',
  });
});

test('two-arg importHook receives EMPTY_ATTRIBUTES on the empty case', async t => {
  let seen;
  const c = new Compartment({
    __options__: true,
    resolveHook: specifier => specifier,
    importHook: async (specifier, attributes) => {
      if (specifier === 'entry') {
        return { source: dynamicImportSource('./dep', {}) };
      }
      seen = attributes;
      return { source: valueSource('ok') };
    },
  });
  const { namespace } = await c.import('entry');
  await namespace.default;
  t.is(seen, EMPTY_ATTRIBUTES);
});

// -- modulesWithAttributes priming ----------------------------------------

test('modulesWithAttributes primes the attribute-bearing memo entry', async t => {
  let hookCalledForDep = false;
  const c = new Compartment({
    __options__: true,
    resolveHook: specifier => specifier,
    modulesWithAttributes: [
      ['./data.json', { type: 'json' }, valueSource({ primed: true })],
    ],
    importHook: async (specifier, _attributes) => {
      if (specifier === 'entry') {
        return { source: dynamicImportSource('./data.json', { type: 'json' }) };
      }
      hookCalledForDep = true;
      return { source: valueSource({ primed: false }) };
    },
  });
  const { namespace } = await c.import('entry');
  const depNamespace = await namespace.default;
  t.deepEqual(depNamespace.default, { primed: true });
  t.false(hookCalledForDep, 'importHook is not consulted for a primed entry');
});

test('modulesWithAttributes does not satisfy an unattributed import', async t => {
  let hookAttrs;
  const c = new Compartment({
    __options__: true,
    resolveHook: specifier => specifier,
    modulesWithAttributes: [
      ['./data.json', { type: 'json' }, valueSource('typed')],
    ],
    importHook: async (specifier, attributes) => {
      if (specifier === 'entry') {
        return { source: dynamicImportSource('./data.json', {}) };
      }
      hookAttrs = attributes;
      return { source: valueSource('plain') };
    },
  });
  const { namespace } = await c.import('entry');
  const depNamespace = await namespace.default;
  t.is(depNamespace.default, 'plain', 'legacy slot bypasses the typed priming');
  t.is(hookAttrs, EMPTY_ATTRIBUTES);
});
