// B8: the host renderer, through the completion value. Mixed elements: holes, undefined and
// null, nested and empty arrays, wrappers, typed arrays, errors, functions, RegExps, BigInts,
// collections, arguments objects and plain objects.
var args = (function () { return arguments; })(1, [2]);
var e = new RangeError('bad'); var e2 = new Error(''); e2.name = '';
[1, , undefined, null, [2, [3, [], [[]]], ''], 'str', -0, 1e21, 12n, new Number(5), new String('w'),
  new Boolean(false), new Int8Array([1, -2]), new BigInt64Array(2), e, e2, function named() {}, /a+b/g,
  new Map(), new Set(), Promise.resolve(), args, {}, [new Number(7), [new String('deep')]], [, ,], [null]]
// ---
// Indices moved out of the compact item table by a restrictive descriptor render from the
// property chain: data values (including nested arrays) render, accessors and undefined do not.
var a = [0, 1, 2, 3, 4];
Object.defineProperty(a, '1', { value: [9, [8]], writable: false });
Object.defineProperty(a, '2', { get: function () { return 'never'; } });
Object.defineProperty(a, '3', { value: undefined, enumerable: false });
var inner = [5, 6];
Object.defineProperty(inner, '0', { value: [a.length, [7]], configurable: false });
a[4] = inner;
[a, [a], [[inner]]]
// ---
// A nest at the renderer's ceiling (the render starts from the depth the run ends at).
var a = 'leaf';
for (var i = 0; i < 2048; i++) a = [a];
a
// ---
// One past the ceiling is refused.
var a = 'leaf';
for (var i = 0; i < 2049; i++) a = [a];
a
// ---
// A wrapper at the bottom of a nest at the ceiling descends once more.
var a = new Number(3);
for (var i = 0; i < 2047; i++) a = [a];
a
// ---
// A wrapper under a nest at the ceiling is refused.
var a = new String('s');
for (var i = 0; i < 2048; i++) a = [a];
a
// ---
// A typed array at the bottom of a nest at the ceiling renders its elements without descending.
var a = new Uint8Array([1, 2, 3]);
for (var i = 0; i < 2047; i++) a = [a];
a
// ---
// A self-containing array is refused at the ceiling.
var a = [1];
a.push(a);
a
// ---
// Wide and deep: many siblings, each a nest, with the deepest sibling last.
var out = [];
for (var k = 0; k < 40; k++) {
  var n = [k];
  for (var i = 0; i < 50 * k; i++) n = [n, i % 3 ? null : i];
  out.push(n);
}
out
// ---
// A deep nest rendered inside a guest computation that is itself deep: the renderer starts
// from the native depth the run ends at.
function rec(n) { if (n === 0) { var a = 'x'; for (var i = 0; i < 1900; i++) a = [a]; return a; } return rec(n - 1); }
rec(50)
// ---
// An uncaught thrown array renders through the same path.
var a = [1, [2, [3]]];
for (var i = 0; i < 100; i++) a = [a, i];
throw a;

// ---
// From the pre-commit review: B8 review: every level reached through the materialized-index branch (a non-writable
// defineProperty moves the element out of the item table), at the ceiling.
var a = 'leaf';
for (var i = 0; i < 2048; i++) { var b = [0]; Object.defineProperty(b, '0', { value: a, writable: false }); a = b; }
a
// ---
// The materialized-index branch one past the ceiling is refused.
var a = 'leaf';
for (var i = 0; i < 2049; i++) { var b = [0]; Object.defineProperty(b, '0', { value: a, writable: false }); a = b; }
a
// ---
// A self-cycle through a materialized index is refused.
var a = [0, 1];
Object.defineProperty(a, '1', { value: a, writable: false });
a
// ---
// Alternating compact and materialized levels, each with leading holes, nulls, undefined and
// trailing holes, so the comma count per level is checked at depth; at the ceiling.
var a = 'z';
for (var i = 0; i < 2048; i++) {
  var b = [, null, undefined, 0, , ];
  b.length = 7;
  if (i % 2) Object.defineProperty(b, '3', { value: a, writable: false, enumerable: true });
  else b[3] = a;
  a = b;
}
var s = String(a.length);
a
// ---
// A wrapper reached through the materialized branch at the deepest level: refused one level
// later than an array would be.
var a = new Boolean(true);
for (var i = 0; i < 2047; i++) { var b = [0]; Object.defineProperty(b, '0', { value: a, writable: false }); a = b; }
a
// ---
// The same, one level deeper: the wrapper's descend is refused.
var a = new Boolean(true);
for (var i = 0; i < 2048; i++) { var b = [0]; Object.defineProperty(b, '0', { value: a, writable: false }); a = b; }
a
// ---
// An accessor index, an undefined-valued data index and a null-valued data index in the
// materialized branch, at depth, beside a nested array that renders.
var a = [1, 2, 3, [4, [5]], 6];
Object.defineProperty(a, '0', { get: function () { return 'never'; } });
Object.defineProperty(a, '1', { value: null, writable: false });
Object.defineProperty(a, '2', { value: undefined, writable: false });
var n = a;
for (var i = 0; i < 1500; i++) n = [n, i];
n
// ---
// Siblings at the ceiling: the first sibling is a nest exactly at the ceiling and a later
// sibling one past it, so the refusal comes after a full render of the first.
function nest(k, leaf) { var a = leaf; for (var i = 0; i < k; i++) a = [a]; return a; }
[nest(2047, 'ok'), 'mid', nest(2048, 'bad')]
// ---
// Siblings where every sibling reaches exactly the ceiling.
function nest(k, leaf) { var a = leaf; for (var i = 0; i < k; i++) a = [a]; return a; }
var out = [];
for (var j = 0; j < 30; j++) out.push(nest(2047, j));
out
// ---
// Arguments objects, typed arrays (BigInt and Number), errors whose name/message are arrays,
// collections and plain objects as elements at depth, with the leaf arms at the ceiling.
var args = (function () { return arguments; })([1, [2]], 3);
var e = new TypeError('m'); e.name = ['x', ['y']];
var e2 = new Error([1, 2]);
var leaves = [args, new BigUint64Array([1n, 2n]), new Float64Array([0.5, -0]), e, e2, new WeakMap(), Object.create(null), { [Symbol.toStringTag]: 'Tag' }];
var a = leaves;
for (var i = 0; i < 2047; i++) a = [a];
a
// ---
// A thrown nest past the ceiling falls back to the reference stub.
var a = [1];
for (var i = 0; i < 2100; i++) a = [a];
throw a;
// ---
// A thrown self-containing array falls back to the reference stub.
var a = [1];
a.push([a]);
throw a;
// ---
// A thrown error whose message is a primitive renders through the error arm.
var e = new RangeError('deep');
throw [[[e, [e]]]];
// ---
// A wide array with many shallow nests and holes: the comma placement across thousands of
// open/close transitions.
var out = [];
for (var i = 0; i < 3000; i++) out.push(i % 5 === 0 ? [] : i % 5 === 1 ? [[i], , [null]] : i % 5 === 2 ? [, , ] : i % 5 === 3 ? [i, [i, [i]]] : undefined);
out.length = 3005;
out
// ---
// Sparse arrays with a large length: holes render as commas.
var a = [];
a[2000] = [1, [2]];
a.length = 2005;
[a, [a]]
// ---
// A RegExp, a symbol-valued element and a BigInt wrapper at depth.
var a = [/x/y, Object(1n), new String(''), Object(Symbol.iterator) ? 1 : 0, [[[]]]];
for (var i = 0; i < 2046; i++) a = [a];
a
