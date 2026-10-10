// B5: JSON.stringify with an explicit container stack. Scalars, omissions and nulls at
// depth, in arrays and objects, with and without a gap.
var leaf = [1, -0, 1.5e300, NaN, Infinity, 'q"\\\n\u2028\ud800x', true, false, null, undefined,
  function () {}, Symbol('s'), new Number(3), new String('w'), new Boolean(false), Object(1n),
  [], {}, [[]], { a: {} }];
var o = { [Symbol('k')]: 1, u: undefined, f: function () {}, list: leaf };
var deep = o;
for (var i = 0; i < 30; i++) deep = i % 2 ? [deep, i] : { i: i, d: deep, z: null };
var r = [];
try { JSON.stringify(deep); } catch (e) { r.push(e.name); }
leaf.splice(15, 1);
r.push(JSON.stringify(deep).length, JSON.stringify(deep, null, 2).length, JSON.stringify(deep, null, '\t-').slice(0, 300));
r.join(' ')
// ---
// Gaps: numbers clamped to 10, strings truncated to ten code units (a lone surrogate kept),
// wrapper objects, and nested empty containers under indentation.
var v = { a: [[], {}, [{}], { b: [] }], c: { d: { e: [1, [2, [3]]] } } };
[0, 1, 4, 10, 11, -3, 1.9, '', ' ', '----------xx', '\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d\ude00\ud83d',
  new Number(2), new String('**'), null, true].map(function (g) {
  return JSON.stringify(v, null, g);
}).join('|')
// ---
// toJSON at depth: called with the key, its result serialized in place (including another
// object with toJSON, a primitive, undefined and a deep structure), and on BigInt.
var log = [];
function T(tag, out) { this.toJSON = function (k) { log.push(tag + ':' + JSON.stringify(k)); return out; }; }
BigInt.prototype.toJSON = function (k) { log.push('big:' + k); return this.toString() + 'n'; };
var nested = new T('outer', new T('inner', { x: [new T('deepest', 'leaf')] }));
var v = { a: nested, b: [new T('u', undefined), 2n, new T('p', 7)], c: { d: new T('arr', [[[new T('z', null)]]]) } };
var out = JSON.stringify(v);
delete BigInt.prototype.toJSON;
[out, log.join(',')].join(' ')
// ---
// A replacer function: the holder, key and value at every level, the root wrapper, replaced
// values that are containers, and omissions.
var log = [];
var v = { a: [1, { b: 2, c: [3] }], d: 'x', e: { f: { g: { h: 'deep' } } } };
var out = JSON.stringify(v, function (k, val) {
  log.push((Array.isArray(this) ? 'A' : typeof this) + '/' + JSON.stringify(k) + '/' + (typeof val));
  if (k === 'b') return [val, { wrapped: val }];
  if (k === 'd') return undefined;
  if (k === 'h') return { replaced: [val] };
  return val;
}, 1);
[out, log.join(' ')].join(' | ')
// ---
// A replacer list: duplicates, numbers, wrapper objects, index names, absent names, and the
// list applied at every object level but not to arrays.
var v = { 1: 'one', a: { 1: 'inner', b: [{ a: 1, b: 2, c: 3 }], z: 0 }, b: 'B', '': 'empty', c: { a: { a: { a: 'deep' } } } };
[JSON.stringify(v, ['a', 'b', 1, 'a', new String('c'), new Number(1), 'missing', '']),
  JSON.stringify(v, ['c', 'a'], 2), JSON.stringify([v, [v]], ['a'])].join(' | ')
// ---
// Getters that mutate during the walk: a later sibling replaced, a parent's later member
// deleted, an index property named after the key snapshot, and an array grown.
var log = [];
var inner = { get x() { log.push('x'); delete outer.later; inner.y = 'added'; arr.push(99); return 1; }, y: 'orig' };
var arr = [0, { get g() { log.push('g'); arr[3] = { late: true }; return [inner]; } }, 2];
var outer = { first: arr, later: 'gone?', last: 'z' };
var o2 = { a: 1 };
Object.defineProperty(o2, 'b', { enumerable: true, get: function () { o2[7] = 'seven'; Object.defineProperty(o2, 'a', { value: 'changed', enumerable: true }); return 'b'; } });
[JSON.stringify(outer), JSON.stringify([o2, o2]), log.join()].join(' | ')
// ---
// Proxies at depth: ownKeys, getOwnPropertyDescriptor and get traps logged in order, an array
// Proxy whose length is trapped, and a revoked Proxy deep inside.
var log = [];
function P(t, tag) {
  return new Proxy(t, {
    ownKeys: function (t) { log.push(tag + ':keys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor: function (t, k) { log.push(tag + ':gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
    get: function (t, k, r) { log.push(tag + ':get:' + String(k)); return Reflect.get(t, k, r); },
  });
}
var v = P({ a: P([1, P({ b: 2 }, 'in'), 3], 'arr'), c: P({}, 'empty') }, 'top');
var r = [JSON.stringify(v), log.join(',')];
var rv = Proxy.revocable({}, {}); rv.revoke();
try { JSON.stringify({ a: [{ b: [rv.proxy] }] }); } catch (e) { r.push(e.name); }
r.join(' | ')
// ---
// Cycles at depth through arrays and objects are TypeErrors; a shared (acyclic) object
// serializes each time.
var r = [];
var a = [1, { b: [2] }]; a[1].b.push(a);
try { JSON.stringify({ x: [[a]] }); } catch (e) { r.push(e.name); }
var o = { p: { q: {} } }; o.p.q.r = o.p;
try { JSON.stringify([o]); } catch (e) { r.push(e.name); }
var w = { inner: {} }; w.inner.toJSON = function () { return w; };
try { JSON.stringify([[w]]); } catch (e) { r.push(e.name); }
var shared = { k: [1] };
r.push(JSON.stringify([shared, { s: shared }, [[shared]]]));
r.join()
// ---
// A toJSON that returns a fresh object holding itself is no cycle: the walk deepens until the
// budget halts it.
var t = { toJSON: function () { return { again: t }; } };
JSON.stringify([[t]]);
// ---
// Errors thrown at every depth unwind, and a stringify at its ceiling still completes.
var r = [];
for (var d = 0; d < 1900; d += 100) {
  var v = { get bad() { throw new RangeError('at ' + d); } };
  for (var i = 0; i < d; i++) v = i % 2 ? [v] : { v: v };
  try { JSON.stringify(v); } catch (e) { r.push(e.message); }
  var c = [1]; c.push(c);
  for (var i = 0; i < d; i++) c = [c];
  try { JSON.stringify(c); } catch (e) { r.push(e.name); }
  var b = 1n;
  for (var i = 0; i < d; i++) b = { b: b };
  try { JSON.stringify(b); } catch (e) { r.push(e.name); }
}
var ok = 1;
for (var i = 0; i < 2015; i++) ok = [ok];
r.push(JSON.stringify(ok).length);
r.join()
// ---
// The ceiling inside a replacer callback and inside toJSON.
var r = [];
JSON.stringify([1], function (k, v) {
  if (k === '0') {
    for (var d = 1850; d <= 1940; d += 10) { var n = 0; for (var i = 0; i < d; i++) n = { n: n }; JSON.stringify(n); r.push(d); }
  }
  return v;
});
var t = { toJSON: function () { for (var d = 1900; d <= 1950; d += 5) { var a = 0; for (var i = 0; i < d; i++) a = [a]; JSON.stringify(a); r.push(d); } return 1; } };
JSON.stringify([[t]]);
r.join()
// ---
// One past the ceiling halts, in an array nest and in an object nest.
var a = 0;
for (var i = 0; i < 2016; i++) a = [a];
JSON.stringify(a);
// ---
var o = 0;
for (var i = 0; i < 2016; i++) o = { o: o };
JSON.stringify(o, null, 1);
// ---
// A replacer's nest past the ceiling halts while it is serialized.
var once = true;
JSON.stringify([1], function (k, v) {
  if (k === '0' && once) { once = false; var n = 0; for (var i = 0; i < 2010; i++) n = [n]; return n; }
  return v;
});
// ---
// Wide containers at depth, with and without a gap.
var row = [];
for (var i = 0; i < 2000; i++) row.push(i % 3 ? { k: i } : [i, 'v' + i]);
var v = { a: { b: [row, { c: row }] } };
[JSON.stringify(v).length, JSON.stringify(v, null, 3).length, JSON.stringify(v, ['a', 'b', 'c', 'k']).length].join()

// ---
// From the pre-commit review: the root wrapper with a replacer: the replacer sees the wrapper as `this`, mutates
// it, deletes from it, and returns a nested container; toJSON at the root runs before it.
var log = [];
var root = { toJSON: function (k) { log.push('toJSON:' + JSON.stringify(k) + ':' + (this === root)); return { r: [1, { s: 2 }] }; } };
var out = JSON.stringify(root, function (k, v) {
  log.push(JSON.stringify(k) + ':' + Object.keys(this).join('+') + ':' + (Array.isArray(this) ? 'A' : typeof this));
  if (k === '') { this[''] = 'mutated'; this.extra = 1; delete this['']; return [v, v.r]; }
  return v;
}, '  ');
[out, log.join(' ')].join(' | ')
// ---
// B5 extra: a replacer that returns the holder (a cycle through the replacer), an ancestor, and a
// fresh container at every level until a depth, with a gap.
var r = [];
var a = { b: { c: { d: 1 } } };
try { JSON.stringify(a, function (k, v) { return k === 'd' ? this : v; }); } catch (e) { r.push(e.name + ':' + e.message); }
try { JSON.stringify(a, function (k, v) { return k === 'c' ? a : v; }); } catch (e) { r.push(e.name); }
var n = 0;
r.push(JSON.stringify({ x: 0 }, function (k, v) { if (k === 'x' && n < 40) { n++; return [{ x: n }, n]; } return v; }, 3).length);
r.join(' ')
// ---
// B5 extra: a replacer list with index names applied to objects with index keys, a key promoted
// to a name mid-walk by a getter, and the list applied below arrays at depth, with gaps.
var log = [];
var o = { 0: 'zero', 1: { 1: 'one-one', 0: [{ 0: 'deep', 2: 'skip' }] }, 2: 'two' };
Object.defineProperty(o, 'a', { enumerable: true, get: function () { log.push('a'); Object.defineProperty(o, '2', { get: function () { log.push('2'); return 'promoted'; }, enumerable: true, configurable: true }); return 'A'; } });
var list = ['a', 0, '1', 2, '0', 'length'];
var out1 = JSON.stringify(o, list);
var out2 = JSON.stringify([o, [o]], list, '\u2028\ud800.');
var out3 = JSON.stringify({ length: 3, 0: 'x' }, list, 4);
[out1, out2, out3, log.join()].join(' | ')
// ---
// B5 extra: empty containers, all-omitted members, all-undefined elements, under every gap shape.
var v = [{}, [], { u: undefined, f: function () {}, s: Symbol() }, [undefined, function () {}, Symbol()], [[{}]], { a: { b: { c: {} } } }];
var r = [];
[undefined, 0, 1, 10, '', 'x', '\ud83d\ude00', '0123456789abc', '\n\t'].forEach(function (g) { r.push(JSON.stringify(v, null, g)); });
r.push(JSON.stringify(v, [], 2), JSON.stringify(v, function (k, x) { return k === '' ? x : (typeof x === 'object' ? x : undefined); }, 2));
r.join('#')
// ---
// B5 extra: getters that shrink an ancestor array mid-walk, delete later members, add members,
// and turn a later element into a Proxy; the length and key snapshots hold.
var log = [];
var arr = [1, 2, 3, 4, 5];
var obj = { a: 1, b: 2, c: 3 };
arr[1] = { get g() { log.push('g'); arr.length = 2; delete obj.b; obj.z = 'new'; obj.c = new Proxy({ p: 1 }, { ownKeys: function (t) { log.push('ok'); return ['p', 'q']; }, getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + k); return k === 'q' ? { value: 'Q', enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k); }, get: function (t, k) { log.push('get:' + String(k)); return k === 'q' ? 'QQ' : t[k]; } }); return 'G'; } };
var out = JSON.stringify({ arr: arr, obj: obj }, null, 1);
[out, log.join()].join(' | ')
// ---
// B5 extra: toJSON variants: a toJSON getter, toJSON on an array and on a function-valued
// property, toJSON returning BigInt, a BigInt toJSON at depth seeing the key, and wrapper objects
// with overridden valueOf/toString at depth.
var log = [];
var r = [];
var withGetter = {};
Object.defineProperty(withGetter, 'toJSON', { get: function () { log.push('get toJSON'); return function (k) { log.push('call ' + k); return [k]; }; } });
var arr = [1, 2]; arr.toJSON = function (k) { log.push('arr ' + k); return { from: 'arr' }; };
r.push(JSON.stringify({ w: withGetter, a: arr, nest: [[withGetter]] }));
try { JSON.stringify([{ toJSON: function () { return 5n; } }]); } catch (e) { r.push(e.name); }
BigInt.prototype.toJSON = function (k) { log.push('big ' + JSON.stringify(k) + ' ' + typeof this); return Number(this); };
r.push(JSON.stringify({ a: [1n, { b: 2n }], c: Object(3n) }, function (k, v) { log.push('rep ' + k + ' ' + typeof v); return v; }));
delete BigInt.prototype.toJSON;
try { JSON.stringify([[Object(4n)]]); } catch (e) { r.push(e.name); }
var n = new Number(7); n.valueOf = function () { log.push('valueOf'); return 8; }; n.toString = function () { log.push('toString'); return 'nine'; };
var s = new String('s'); s.toString = function () { log.push('s.toString'); return 'str'; }; s.valueOf = function () { log.push('s.valueOf'); return 'val'; };
var b = new Boolean(false); b.valueOf = function () { log.push('b.valueOf'); return true; };
r.push(JSON.stringify([[n, s, b]], null, 1));
[r.join(' '), log.join(',')].join(' | ')
// ---
// B5 extra: cycles detected through toJSON returning an ancestor and through a Proxy of an
// ancestor (a different object, so no cycle until the walk reaches the real one again).
var r = [];
var a = { b: [] }; a.b.push({ toJSON: function () { return a; } });
try { JSON.stringify(a); } catch (e) { r.push('toJSON-cycle ' + e.name); }
var p = { q: null }; p.q = new Proxy(p, {});
try { JSON.stringify(p); } catch (e) { r.push('proxy ' + e.name); }
var x = [0]; var px = new Proxy(x, {}); x[0] = px;
try { JSON.stringify(x); } catch (e) { r.push('proxy-arr ' + e.name); }
var deep = { k: 1 }; for (var i = 0; i < 14; i++) deep = [deep, { s: deep }];
try { r.push(JSON.stringify(deep).length); } catch (e) { r.push('deep ' + e.name); }
r.join()
// ---
// B5 extra: errors thrown from every phase at depth (Get, toJSON lookup, toJSON call, replacer,
// ownKeys, getOwnPropertyDescriptor, length, wrapper coercion, revoked is-array check, BigInt),
// each caught, then a stringify that reuses the budget.
var r = [];
function nest(v, d) { for (var i = 0; i < d; i++) v = i % 2 ? [v] : { v: v }; return v; }
var rv = Proxy.revocable([], {}); rv.revoke();
var bad = [
  { get g() { throw new Error('get'); } },
  { get toJSON() { throw new Error('toJSON-get'); } },
  { toJSON: function () { throw new Error('toJSON-call'); } },
  new Proxy({}, { ownKeys: function () { throw new Error('ownKeys'); } }),
  new Proxy({ a: 1 }, { getOwnPropertyDescriptor: function () { throw new Error('gopd'); } }),
  new Proxy([], { get: function (t, k) { if (k === 'length') throw new Error('length'); return t[k]; } }),
  (function () { var n = new Number(1); n.valueOf = function () { throw new Error('valueOf'); }; return n; })(),
  rv.proxy,
  10n,
];
for (var d = 0; d < 1800; d += 450) {
  bad.forEach(function (b, j) {
    try { JSON.stringify(nest(b, d), j % 2 ? function (k, v) { if (k === 'boom') throw 0; return v; } : null, j % 3); r.push('ok'); }
    catch (e) { r.push(e && e.message || String(e)); }
  });
}
r.push(JSON.stringify(nest(1, 1990)).length);
r.join()
// ---
// B5 extra: the replacer throws at depth inside a Proxy holder, and the replacer itself
// stringifies its value (re-entry) with a different gap, at depth.
var r = [];
var log = [];
var v = { a: [{ b: new Proxy({ c: [1, 2] }, { get: function (t, k) { log.push('get ' + String(k)); return t[k]; } }) }] };
try { JSON.stringify(v, function (k, x) { if (k === '1') throw new TypeError('at ' + k); return x; }); } catch (e) { r.push(e.message); }
r.push(JSON.stringify(v, function (k, x) { if (k === 'c') return JSON.stringify(x, null, '>'); return x; }, 2));
[r.join(' '), log.join()].join(' | ')
// ---
// B5 extra: a sparse array whose holes, accessors and inherited indices are read live.
var log = [];
Array.prototype[3] = 'inherited';
var a = [1, , 3, , 5]; a.length = 8;
Object.defineProperty(a, 6, { get: function () { log.push('six'); a[7] = 'late'; return [this === a]; }, enumerable: false });
var out = JSON.stringify([a, { a: a }], null, '-');
delete Array.prototype[3];
[out, log.join()].join(' | ')
// ---
// B5 extra: an oversized Proxy array length at depth refuses.
var p = new Proxy([], { get: function (t, k) { return k === 'length' ? 4294967296 : t[k]; } });
var v = p; for (var i = 0; i < 100; i++) v = { v: [v] };
JSON.stringify(v);
// ---
// B5 extra: a Proxy array length just under the u32 bound at depth: the parts scratch is refused
// by the heap admission.
var p = new Proxy([], { get: function (t, k) { return k === 'length' ? 4294967295 : t[k]; } });
var v = p; for (var i = 0; i < 100; i++) v = { v: [v] };
JSON.stringify(v, null, 2);
// ---
// B5 extra: a sparse array whose parts scratch is just admitted: the index keys are spelled and
// read one by one (holes become null) and the result is assembled.
var a = []; a.length = 300000;
var s = JSON.stringify({ a: [a, [a]] }, null, 1);
s.length
// ---
// B5 extra: a wide object with long keys and a gap, the replacer listing a subset.
var o = {};
for (var i = 0; i < 3000; i++) o['key\u0001"' + i + 'x'.repeat(i % 50)] = i % 4 ? { n: i, s: 'v'.repeat(i % 7) } : [i];
var list = Object.keys(o).filter(function (k, i) { return i % 3 === 0; }).concat(['n', 's']);
[JSON.stringify(o).length, JSON.stringify(o, null, '\t\t').length, JSON.stringify(o, list, 1).length].join()
// ---
// B5 extra: a shared, acyclic DAG whose serialization doubles per level exhausts the heap while
// the parts are assembled, under a gap.
var deep = { k: 'v'.repeat(64) }; for (var i = 0; i < 40; i++) deep = [deep, { s: deep }];
JSON.stringify(deep, null, 1).length
// ---
// B5 extra: one megabyte string repeated: the output admission crosses the chunk ceiling at an
// exact element, in an array and as object members.
var s = 'x'.repeat(1 << 20);
var a = []; for (var i = 0; i < 140; i++) a.push(i % 2 ? s : { k: s });
JSON.stringify(a).length
// ---
// B5 extra: root values that serialize to nothing or to a scalar, with and without a replacer,
// and a root toJSON or replacer that returns undefined, a function or a Symbol.
var r = [];
[undefined, function () {}, Symbol('s'), null, true, 0, -0, 1e21, 'str', 5n, Object(5n), new Number(2), [], {}].forEach(function (v) {
  try { r.push(String(JSON.stringify(v))); } catch (e) { r.push(e.name); }
  try { r.push(String(JSON.stringify(v, function (k, x) { return x; }, 2))); } catch (e) { r.push(e.name); }
});
r.push(String(JSON.stringify({ toJSON: function () { return undefined; } })));
r.push(String(JSON.stringify([1], function (k, x) { return k === '' ? undefined : x; })));
r.push(String(JSON.stringify([1], function (k, x) { return k === '' ? Symbol() : x; })));
r.push(String(JSON.stringify({ a: 1 }, function (k, x) { return k === '' ? function () {} : x; })));
r.join('|')
// ---
// B5 extra: a replacer list read from a Proxy array (its length and index reads logged), with a
// getter on the list that mutates it after it was read.
var log = [];
var list = ['b', 'a'];
var p = new Proxy(list, { get: function (t, k, rcv) { log.push('list.get:' + String(k)); return Reflect.get(t, k, rcv); } });
var v = { a: { b: { a: 1, c: 2 }, a: [{ b: 3 }] }, b: { get a() { log.push('mut'); list.push('c'); return 'A'; } } };
[JSON.stringify(v, p, 1), log.join()].join(' | ')
// ---
// B5 extra: a top-level array nest, at the ceiling (2015).
var a = 0; for (var i = 0; i < 2015; i++) a = [a]; JSON.stringify(a).length
// ---
// B5 extra: a top-level array nest, one past the ceiling (2016).
var a = 0; for (var i = 0; i < 2016; i++) a = [a]; JSON.stringify(a).length
// ---
// B5 extra: an object nest with a replacer function (root wrapper) and a gap, at the ceiling (1999).
var o = 0; for (var i = 0; i < 1999; i++) o = { o: o }; JSON.stringify(o, function (k, v) { return v; }, 2).length
// ---
// B5 extra: an object nest with a replacer function (root wrapper) and a gap, one past the ceiling (2000).
var o = 0; for (var i = 0; i < 2000; i++) o = { o: o }; JSON.stringify(o, function (k, v) { return v; }, 2).length
// ---
// B5 extra: an alternating nest with a replacer list and a tab gap, at the ceiling (2015).
var o = 0; for (var i = 0; i < 2015; i++) o = i % 2 ? { o: o, x: 1 } : [o]; JSON.stringify(o, ['o'], '\t').length
// ---
// B5 extra: an alternating nest with a replacer list and a tab gap, one past the ceiling (2016).
var o = 0; for (var i = 0; i < 2016; i++) o = i % 2 ? { o: o, x: 1 } : [o]; JSON.stringify(o, ['o'], '\t').length
// ---
// B5 extra: an array nest stringified inside toJSON at depth 50 of an outer stringify, at the ceiling (1932).
var inner = 0; for (var i = 0; i < 1932; i++) inner = [inner];
var t = { toJSON: function () { return JSON.stringify(inner).length; } };
var o = t; for (var i = 0; i < 50; i++) o = i % 2 ? [o] : { k: o };
JSON.stringify(o).length
// ---
// B5 extra: an array nest stringified inside toJSON at depth 50 of an outer stringify, one past the ceiling (1933).
var inner = 0; for (var i = 0; i < 1933; i++) inner = [inner];
var t = { toJSON: function () { return JSON.stringify(inner).length; } };
var o = t; for (var i = 0; i < 50; i++) o = i % 2 ? [o] : { k: o };
JSON.stringify(o).length
// ---
// B5 extra: an object nest stringified inside a getter at depth 30, outer gap 1, at the ceiling (1951).
var inner = 0; for (var i = 0; i < 1951; i++) inner = { i: inner };
var g = { get x() { return JSON.stringify(inner).length; } };
var o = g; for (var i = 0; i < 30; i++) o = [o];
JSON.stringify(o, null, 1).length
// ---
// B5 extra: an object nest stringified inside a getter at depth 30, outer gap 1, one past the ceiling (1952).
var inner = 0; for (var i = 0; i < 1952; i++) inner = { i: inner };
var g = { get x() { return JSON.stringify(inner).length; } };
var o = g; for (var i = 0; i < 30; i++) o = [o];
JSON.stringify(o, null, 1).length
// ---
// B5 extra: an array nest after 50 errors and cycles caught at depth (no unit leaks), at the ceiling (2015).
var r = 0;
for (var n = 0; n < 25; n++) {
  var v = { get bad() { throw new Error('x'); } };
  for (var i = 0; i < 1960 - n; i++) v = i % 3 ? [v] : { v: v };
  try { JSON.stringify(v, n % 2 ? function (k, x) { return x; } : null, n % 3); } catch (e) { r++; }
  var c = [1]; var top = c; for (var i = 0; i < 1000 + n * 30; i++) c = { c: c }; top.push(c);
  try { JSON.stringify(c); } catch (e) { r++; }
}
var ok = 0; for (var i = 0; i < 2015; i++) ok = [ok];
r + ':' + JSON.stringify(ok).length
// ---
// B5 extra: an array nest after 50 errors and cycles caught at depth (no unit leaks), one past the ceiling (2016).
var r = 0;
for (var n = 0; n < 25; n++) {
  var v = { get bad() { throw new Error('x'); } };
  for (var i = 0; i < 1960 - n; i++) v = i % 3 ? [v] : { v: v };
  try { JSON.stringify(v, n % 2 ? function (k, x) { return x; } : null, n % 3); } catch (e) { r++; }
  var c = [1]; var top = c; for (var i = 0; i < 1000 + n * 30; i++) c = { c: c }; top.push(c);
  try { JSON.stringify(c); } catch (e) { r++; }
}
var ok = 0; for (var i = 0; i < 2016; i++) ok = [ok];
r + ':' + JSON.stringify(ok).length
// ---
// B5 extra: a Proxy nest whose get trap runs at every level, at the ceiling (1982).
var log = 0;
var h = { get: function (t, k, rcv) { log++; return Reflect.get(t, k, rcv); } };
var o = 0; for (var i = 0; i < 1982; i++) o = new Proxy(i % 2 ? [o] : { o: o }, h);
JSON.stringify(o).length + ':' + log
// ---
// B5 extra: a Proxy nest whose get trap runs at every level, one past the ceiling (1983).
var log = 0;
var h = { get: function (t, k, rcv) { log++; return Reflect.get(t, k, rcv); } };
var o = 0; for (var i = 0; i < 1983; i++) o = new Proxy(i % 2 ? [o] : { o: o }, h);
JSON.stringify(o).length + ':' + log
// ---
// B5 extra: a nest ending in a BigInt whose toJSON returns an array, at the ceiling (1967).
var o = 1n; for (var i = 0; i < 1967; i++) o = i % 2 ? [o] : { o: o };
BigInt.prototype.toJSON = function (k) { return [k, String(this)]; };
JSON.stringify(o).length
// ---
// B5 extra: a nest ending in a BigInt whose toJSON returns an array, one past the ceiling (1968).
var o = 1n; for (var i = 0; i < 1968; i++) o = i % 2 ? [o] : { o: o };
BigInt.prototype.toJSON = function (k) { return [k, String(this)]; };
JSON.stringify(o).length
// ---
// B5 extra: the output admission at the chunk ceiling, the last element an object member, at the ceiling (520473).
var s = 'x'.repeat(1 << 20);
var a = []; for (var i = 0; i < 126; i++) a.push(i % 2 ? s : { k: s });
a.push({ k: 'y'.repeat(520473) });
JSON.stringify(a).length
// ---
// B5 extra: the output admission at the chunk ceiling, the last element an object member, one past the ceiling (520474).
var s = 'x'.repeat(1 << 20);
var a = []; for (var i = 0; i < 126; i++) a.push(i % 2 ? s : { k: s });
a.push({ k: 'y'.repeat(520474) });
JSON.stringify(a).length
// ---
// B5 extra: the output admission at the chunk ceiling, the last element an array with a gap, at the ceiling (520156).
var s = 'x'.repeat(1 << 20);
var a = []; for (var i = 0; i < 126; i++) a.push(i % 2 ? s : { k: s });
a.push(['y'.repeat(520156)]);
JSON.stringify(a, null, 1).length
// ---
// B5 extra: the output admission at the chunk ceiling, the last element an array with a gap, one past the ceiling (520157).
var s = 'x'.repeat(1 << 20);
var a = []; for (var i = 0; i < 126; i++) a.push(i % 2 ? s : { k: s });
a.push(['y'.repeat(520157)]);
JSON.stringify(a, null, 1).length
// ---
// B5 extra: a sparse array: the index-key chunks and output admission at the chunk ceiling, at the ceiling (9665907).
JSON.stringify(new Array(9665907)).length
// ---
// B5 extra: a sparse array: the index-key chunks and output admission at the chunk ceiling, one past the ceiling (9665908).
JSON.stringify(new Array(9665908)).length
// ---
// B5 extra: a sparse array under a gap inside an object and an array: the chunk ceiling, at the ceiling (7517926).
JSON.stringify({ k: [new Array(7517926)] }, null, 1).length
// ---
// B5 extra: a sparse array under a gap inside an object and an array: the chunk ceiling, one past the ceiling (7517927).
JSON.stringify({ k: [new Array(7517927)] }, null, 1).length
