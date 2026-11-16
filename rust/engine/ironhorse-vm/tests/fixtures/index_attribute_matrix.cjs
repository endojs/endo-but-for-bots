// Index-property attribute matrix (C-16 audit). Shared by
// `tests/index_attribute_matrix.rs` (run in Ironhorse, one case per crank)
// and by Node, which produced the expected signatures the test pins:
//
//   node rust/engine/ironhorse-vm/tests/fixtures/index_attribute_matrix.cjs \
//     > rust/engine/ironhorse-vm/tests/fixtures/index_attribute_matrix.tsv
//
// Each line is `base<TAB>op<TAB>source<TAB>expected`, the source on one line.
// Every value stored below comes from a `const` binding, the source whose
// attribute bits used to leak onto the stored element. A case builds one
// base, applies one operation, and answers a signature of every own
// property: key, the writable/enumerable/configurable bits, and the value.
// `T` marks an operation that threw.
'use strict';

const BASES = {
  // A plain array whose elements all came from `const` bindings.
  arrayConst: `const a = []; a.push(X, X, 1); const t = a;`,
  arrayLiteral: `const t = [X, X, 1];`,
  arrayIndexSet: `const t = []; t[0] = X; t[1] = X; t[2] = 1;`,
  arrayReadOnly: `const t = [X, X, 1]; Object.defineProperty(t, 1, { writable: false });`,
  arrayHidden: `const t = [X, X, 1]; Object.defineProperty(t, 1, { enumerable: false });`,
  arrayFixed: `const t = [X, X, 1]; Object.defineProperty(t, 1, { configurable: false });`,
  arrayHole: `const t = [X, , 1];`,
  objectIndex: `const t = {}; t[0] = X; t[1] = X; t[2] = 1;`,
  objectReadOnly: `const t = {}; t[0] = X; t[1] = X; t[2] = 1; Object.defineProperty(t, 1, { writable: false });`,
  typed: `const t = new Uint8Array(3); t[1] = N;`,
};

const OPS = {
  none: ``,
  push: `t.push(C);`,
  pop: `t.pop();`,
  shift: `t.shift();`,
  unshift: `t.unshift(C);`,
  spliceRemove: `t.splice(0, 1);`,
  spliceInsert: `t.splice(1, 0, C);`,
  spliceReplace: `t.splice(1, 1, C);`,
  shrink: `t.length = 1;`,
  grow: `t.length = 5;`,
  reverse: `t.reverse();`,
  sort: `t.sort(() => 0);`,
  fill: `t.fill(N);`,
  copyWithin: `t.copyWithin(0, 1);`,
  write0: `t[0] = C;`,
  write1: `t[1] = N;`,
  writeNew: `t[3] = C;`,
  delete1: `delete t[1];`,
  defineRO: `Object.defineProperty(t, 0, { writable: false });`,
  freeze: `Object.freeze(t);`,
  seal: `Object.seal(t);`,
  preventExtensions: `Object.preventExtensions(t); t[7] = C;`,
  descriptors: `Object.getOwnPropertyDescriptors(t);`,
  freezeNeighbour: `const holder = { t, x: X }; Object.freeze(holder); harden({ y: X });`,
  hardenElement: `harden(X);`,
  freezeCopy: `Object.freeze([...Array.prototype.slice.call(t)]); Object.freeze(Object.assign({}, t));`,
  sealThenWrite: `Object.seal(t); t[0] = C;`,
  freezeThenWrite: `Object.freeze(t); t[0] = C;`,
};

const PRELUDE = `
  const harden = o => {
    if (Object(o) !== o || Object.isFrozen(o)) return o;
    Object.freeze(o);
    for (const k of Reflect.ownKeys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if ('value' in d) harden(d.value);
    }
    return o;
  };
  const X = { x: 1 };
  const C = { c: 1 };
  const N = 7;
`;

const SIGNATURE = `
  const tag = v => v === X ? 'X' : v === C ? 'C' : typeof v === 'object' ? 'o' : String(v);
  const keys = Reflect.ownKeys(t).map(String);
  if (Array.isArray(t)) keys.sort((p, q) => (p === 'length') - (q === 'length'));
  return threw + keys.map(k => {
    const d = Object.getOwnPropertyDescriptor(t, k);
    return k + ':' + (d.writable ? 'w' : '-') + (d.enumerable ? 'e' : '-') +
      (d.configurable ? 'c' : '-') + ':' + tag(d.value);
  }).join(' ');
`;

/** The guest program of one case: a strict function returning its signature. */
const caseSource = (base, op) =>
  `(function () { 'use strict'; ${PRELUDE} ${BASES[base]} let threw = '';
   try { ${OPS[op]} } catch (e) { threw = 'T '; }
   ${SIGNATURE} })()`;

const cases = () => {
  const out = [];
  for (const base of Object.keys(BASES)) {
    for (const op of Object.keys(OPS)) {
      out.push([base, op, caseSource(base, op)]);
    }
  }
  return out;
};

/**
 * Cases where V8 departs from ECMA-262, so Node's answer is not the expected
 * one. `Object.seal` of a non-empty TypedArray must throw: SetIntegrityLevel
 * calls DefinePropertyOrThrow(O, k, { [[Configurable]]: false }) and a
 * TypedArray's [[DefineOwnProperty]] returns false for that (ECMA-262
 * 10.4.5.3 step 1.b.ii). V8 (Node 22) neither throws nor seals.
 */
const SPEC_OVERRIDES = {
  'typed/seal': 'T 0:wec:0 1:wec:7 2:wec:0',
  'typed/sealThenWrite': 'T 0:wec:0 1:wec:7 2:wec:0',
};

if (typeof module !== 'undefined' && require.main === module) {
  // Node: print the expected table the Rust test embeds.
  for (const [base, op, source] of cases()) {
    // eslint-disable-next-line no-eval
    const signature = SPEC_OVERRIDES[`${base}/${op}`] ?? (0, eval)(source);
    const line = source.replace(/\s+/g, ' ');
    console.log(`${base}\t${op}\t${line}\t${signature}`);
  }
} else if (typeof module !== 'undefined') {
  module.exports = { BASES, OPS, PRELUDE, SIGNATURE, caseSource, cases };
}
