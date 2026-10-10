// B4: the fast path. Nests around the 1,024-visit budget of the fast-path check (below it the
// fast path runs, above it the generic one): deep linear nests, wide arrays of shared
// references, and two-level wide nests, each flattened at several depths.
function deep(n) { var a = [n]; for (var i = 0; i < n; i++) a = [i, a, -i]; return a; }
function wide(w, levels) {
  var a = [0, 1];
  for (var l = 0; l < levels; l++) { var b = [l]; for (var i = 0; i < w; i++) b.push(a); a = b; }
  return a;
}
var r = [];
[deep(1021), deep(1022), deep(1023), deep(1024), wide(1022, 1), wide(1023, 1), wide(1024, 1),
  wide(30, 2), wide(31, 2), wide(32, 2), wide(9, 3), wide(10, 3)].forEach(function (a) {
  [0, 1, 2, 1022, 1023, 1024, Infinity].forEach(function (d) {
    var f = a.flat(d);
    r.push(f.length + ':' + f[0] + ':' + f[f.length - 1]);
  });
});
r.join()
// ---
// The fast path's order: leaves of mixed kinds, nested arrays at every position, empty arrays,
// and an array that is an element twice.
var shared = [1, [2, [3, []]], 'x'];
var a = [shared, [], [[]], 0, [shared, null, undefined, [true, [false, [-0, [NaN]]]]], shared, {}, 'tail'];
[1, 2, 3, 4, Infinity].map(function (d) {
  return JSON.stringify(a.flat(d)) + '|' + Object.is(a.flat(d).indexOf(-0), -1);
}).join(' ')
// ---
// What sends a nest to the generic path, at depth: a hole, an accessor, a Proxy, an arguments
// object, a subclass, and a species constructor; each must flatten the same either way.
function deep(n, leaf) { var a = leaf; for (var i = 0; i < n; i++) a = [i, a]; return a; }
var r = [];
var hole = deep(30, [1, , 3]);
var acc = [9]; Object.defineProperty(acc, '0', { get: function () { r.push('get'); return 8; } });
var accessor = deep(30, acc);
var prox = deep(30, new Proxy([4, [5]], {}));
var args = deep(30, (function () { return arguments; })(6, [7]));
class Sub extends Array {}
var sub = Sub.from([1, [2, [3]]]);
var spec = [1, [2]]; spec.constructor = { [Symbol.species]: function (n) { r.push('species'); return {}; } };
[hole, accessor, prox, args, sub].forEach(function (a) {
  [1, 31, 40, Infinity].forEach(function (d) { r.push(JSON.stringify(a.flat(d))); });
});
try { r.push(JSON.stringify(spec.flat())); } catch (e) { r.push(e.name); }
r.join(' ')
// ---
// The fast path at its ceiling: a dense nest 1,022 deep (the check's budget allows it), and
// a self-referencing array under flat(Infinity) that the budget sends to the generic path.
var a = [7];
for (var i = 0; i < 1022; i++) a = [a];
var self = []; self[0] = self;
var r = [a.flat(Infinity).join(), a.flat(1021).length, a.flat(1022).length];
try { self.flat(1000).length; r.push('ok'); } catch (e) { r.push(e.name); }
r.join()
// ---
// Many references to one small array: the fast-path check must stop at its budget, not queue
// every element, and the generic path then flattens them.
var b = [1, [2]];
var a = [];
for (var i = 0; i < 5000; i++) a.push(b);
var r = [a.flat(1).length, a.flat(2).length, a.flat(0).length];
a.push(a);
r.push(a.flat(1).length);
r.join()
// ---
// The generic path through Proxies: IsArray sees through a transparent Proxy, a revoked one
// throws, and a get trap observes every read in order.
var log = [];
var target = [1, [2, [3, [4]]], 5];
var p = new Proxy(target, { get: function (t, k, rcv) { log.push(String(k)); return Reflect.get(t, k, rcv); },
  has: function (t, k) { log.push('has:' + String(k)); return Reflect.has(t, k); } });
var outer = [0, p, [p], 6];
var r = [JSON.stringify(outer.flat(Infinity)), log.join('/')];
var rv = Proxy.revocable([1], {}); rv.revoke();
try { [rv.proxy].flat(); } catch (e) { r.push(e.name); }
try { [[rv.proxy]].flat(Infinity); } catch (e) { r.push(e.name); }
r.join(' ')
// ---
// Mutation during the generic walk: getters on the source that grow, shrink and rewire later
// elements, at different nesting levels.
var inner = [1, 2, 3];
var src = [0, inner, 9];
Object.defineProperty(inner, '0', { get: function () { inner.length = 2; src[2] = [10, [11]]; return 'a'; }, configurable: true });
var deep2 = [[[[src]]]];
var r = [JSON.stringify(deep2.flat(Infinity)), JSON.stringify(src)];
var grow = [1, 2];
Object.defineProperty(grow, '1', { get: function () { grow.push([3, [4]]); return [5]; } });
r.push(JSON.stringify([grow, [grow]].flat(3)));
r.join(' ')
// ---
// flatMap: the callback sees the outermost source only; it returns arrays, Proxies, array-likes
// and deep nests, which flatten one level.
var seen = [];
var a = [1, [2], [[3]], 4];
var out = a.flatMap(function (v, i, arr) {
  seen.push(i + ':' + JSON.stringify(v) + ':' + (arr === a));
  if (i === 0) return [v, [v]];
  if (i === 1) return new Proxy([7, [8]], {});
  if (i === 2) return { length: 2, 0: 'x', 1: 'y' };
  return [[[[v]]]];
});
[JSON.stringify(out), seen.join('|')].join(' ')
// ---
// Depth arguments: absent, undefined, NaN, negative, fractional, huge, strings and objects
// with valueOf, on the fast and the generic path.
var fast = [1, [2, [3, [4]]]];
var generic = [1, [2, [3, new Proxy([4], {})]]];
var depths = [undefined, NaN, -1, 0, 0.9, 1.9, 2, 1e10, Infinity, -Infinity, '2', { valueOf: function () { return 3; } }, null, true];
var r = [];
[fast, generic].forEach(function (a) {
  r.push(a.flat().length);
  depths.forEach(function (d) { r.push(a.flat(d).length); });
});
r.join()
// ---
// The generic path's ceiling: nests of transparent Proxies over arrays near the budget.
function pnest(n) { var a = [1]; for (var i = 0; i < n; i++) a = new Proxy([a], {}); return a; }
var r = [];
for (var n = 900; n <= 1000; n += 25) r.push(pnest(n).flat(Infinity).length);
r.join()
// ---
// One past the generic ceiling halts with the depth the recursion reported.
var self = [];
self[0] = self;
self.flat(Infinity);
// ---
// A generic nest that halts deep inside a flatMap callback's result.
var a = [0];
for (var i = 0; i < 3000; i++) a = [a, new Proxy([], {})];
[1].flatMap(function () { return [a]; }).flat(Infinity);
// ---
// Errors thrown at depth unwind and the next flat at its ceiling still completes.
var r = [];
for (var k = 0; k < 20; k++) {
  var bad = [1]; Object.defineProperty(bad, '0', { get: function () { throw new RangeError('deep'); } });
  var a = bad;
  for (var i = 0; i < 50 * k; i++) a = [new Proxy([a], {})];
  try { a.flat(Infinity); } catch (e) { r.push(e.name + k); }
}
var ok = [1];
for (var i = 0; i < 1990; i++) ok = new Proxy([ok], {});
r.push(ok.flat(Infinity).length);
r.join()
// ---
// From the pre-commit review: B4 review: errors of every kind raised at depth inside the generic walk, each caught, then a
// flat at exactly the top-level ceiling (2,014 nested sources): a unit any error path left
// charged would halt the last flat.
function nest(n, leaf) { var a = leaf; for (var i = 0; i < n; i++) a = [a, new Proxy([], {})]; return a; }
var r = [];
var rv = Proxy.revocable([], {}); rv.revoke();
var badLen = new Proxy([1], { get: function (t, k) { if (k === 'length') throw new EvalError('len'); return t[k]; } });
var symLen = new Proxy([1], { get: function (t, k) { if (k === 'length') return Symbol(); return t[k]; } });
var badHas = new Proxy([1, 2], { has: function () { throw new URIError('has'); } });
var badGet = new Proxy([1, 2], { get: function (t, k) { if (k === '1') throw new SyntaxError('get'); return t[k]; } });
var leaves = [rv.proxy, badLen, symLen, badHas, badGet];
for (var k = 0; k < leaves.length; k++) {
  for (var d = 0; d <= 1960; d += 245) {
    try { nest(d, [0, leaves[k]]).flat(Infinity); r.push('ok'); } catch (e) { r.push(e.name[0] + d); }
  }
}
var frozen = function (n) { var t = []; Object.preventExtensions(t); return t; };
var sp = nest(700, [1, 2]); sp.constructor = { [Symbol.species]: frozen };
try { sp.flat(Infinity); r.push('ok'); } catch (e) { r.push(e.name); }
r.push(nest(2014, [5]).flat(Infinity).length);
r.join()
// ---
// The mapper throws at several outer indices after nested sources were walked, each caught,
// then the ceiling.
function nest(n, leaf) { var a = leaf; for (var i = 0; i < n; i++) a = [a, new Proxy([], {})]; return a; }
var r = [];
for (var k = 0; k < 6; k++) {
  try {
    [1, nest(900, [2]), 3, [4, [5]], 6, 7].flatMap(function (v, i) { if (i === k) throw new RangeError('m' + i); return [v, [v]]; });
    r.push('ok');
  } catch (e) { r.push(e.message); }
}
r.push(nest(2014, [5]).flat(Infinity).length);
r.join()
// ---
// The ceiling inside a getter reached 301 sources deep, after errors raised inside the getter's
// own flats: the getter's flats sit on the outer walk's units.
function nest(n, leaf) { var a = leaf || [1]; for (var i = 0; i < n; i++) a = [a, new Proxy([], {})]; return a; }
var r = [];
var g = [0];
Object.defineProperty(g, '0', { get: function () {
  for (var d = 1500; d <= 1680; d += 30) {
    var bad = [1]; Object.defineProperty(bad, '0', { get: function () { throw new TypeError('t'); } });
    try { nest(d - 40, [bad]).flat(Infinity); } catch (e) { r.push(e.name[0]); }
    r.push(nest(d).flat(Infinity).length);
  }
  return 2;
} });
var outer = g; for (var i = 0; i < 300; i++) outer = [outer];
r.push(outer.flat(Infinity).length);
r.join()
// ---
// One past that ceiling halts with the depth the recursion reported.
function nest(n) { var a = [1]; for (var i = 0; i < n; i++) a = [a, new Proxy([], {})]; return a; }
var g = [0];
Object.defineProperty(g, '0', { get: function () { nest(1681).flat(Infinity); return 2; } });
var outer = g; for (var i = 0; i < 300; i++) outer = [outer];
outer.flat(Infinity).length
// ---
// The ceiling inside a flatMap callback (the outermost source's unit held), then one past it.
function nest(n) { var a = [1]; for (var i = 0; i < n; i++) a = [a, new Proxy([], {})]; return a; }
var r = [];
var outer = [0]; for (var i = 0; i < 300; i++) outer = [outer];
var res = [7, 8].flatMap(function (v, i) { r.push(nest(1981 + i).flat(Infinity).length); return outer; });
r.join()
// ---
// Observable order through logging Proxies at every level, with getters that mutate the walk:
// an inner getter shortens an open outer source, rewires a later sibling into a Proxy nest,
// turns a pending nested array into a plain array-like and appends past a snapshotted length.
var log = [];
function lp(t, name) {
  return new Proxy(t, {
    get: function (o, k, rcv) { log.push(name + '.get:' + String(k)); return Reflect.get(o, k, rcv); },
    has: function (o, k) { log.push(name + '.has:' + String(k)); return Reflect.has(o, k); },
  });
}
var c = [30, 31, 32];
var b = [20, , 22, c, 24];
var top = [10, b, 12, [13, [14]], 15];
Object.defineProperty(b, '0', { get: function () {
  log.push('b0');
  top.length = 4;
  top[3] = lp([40, lp([41, [42]], 'q')], 'p');
  c.length = 1;
  c[5] = 'past';
  b[4] = { length: 2, 0: 'al0', 1: 'al1' };
  return 'B0';
} });
var P = lp([lp(top, 'top'), lp([lp(b, 'b')], 'w')], 'P');
var out = P.flat(Infinity);
[JSON.stringify(out), log.join(' ')].join(' || ')
// ---
// target_index across nested sources and a species target that logs each definition.
var log = [];
var a = [1, new Proxy([2, [3, , 4], [[5]]], {}), 6, [[7, [8, [9]]]], , 10];
a.constructor = { [Symbol.species]: function (n) {
  log.push('species:' + n);
  return new Proxy({}, { defineProperty: function (t, k, d) { log.push(k + '=' + JSON.stringify(d.value)); return Reflect.defineProperty(t, k, d); } });
} };
var res = a.flat(Infinity);
[log.join(' '), Object.keys(res).join()].join(' || ')
// ---
// flatMap: the mapper applies to the outermost source only, sees the source as receiver and the
// thisArg; its results are flattened one level, Proxies seen through, array-likes and
// arguments objects kept as leaves; mutation of the source during mapping is observed.
var seen = [];
var src = [1, 2, 3, 4, 5];
var args = (function () { return arguments; })('a1', ['a2']);
var res = src.flatMap(function (v, i, arr) {
  seen.push([v, i, arr === src, this.tag].join(':'));
  if (i === 0) { src.push(99); src[3] = [44, [45]]; return [[v, [v]], new Proxy([['p']], {})]; }
  if (i === 1) return args;
  if (i === 2) return { length: 1, 0: 'like' };
  if (i === 3) return v;
  return new Proxy([v, new Proxy([[v]], {})], {});
}, { tag: 'T' });
[JSON.stringify(res), seen.join('|')].join(' || ')
// ---
// flatMap over an array-like receiver with getters, through Array.prototype.flatMap.call, and
// flat over a String wrapper, a typed array and an arguments object as receivers.
var log = [];
var like = { length: 4 };
Object.defineProperty(like, '0', { get: function () { log.push('g0'); like.length = 10; like[2] = [2, [2]]; return [0]; } });
like[1] = [1, [1, [1]]];
like[3] = new Proxy([[3]], {});
var r = [JSON.stringify(Array.prototype.flatMap.call(like, function (v, i, o) { log.push('m' + i + (o === like)); return v; })), log.join()];
r.push(JSON.stringify(Array.prototype.flat.call(new String('abc'), Infinity)));
r.push(JSON.stringify(Array.prototype.flat.call(new Uint8Array([1, 2]), Infinity)));
r.push(JSON.stringify(Array.prototype.flat.call((function () { return arguments; })([1, [2]], 3), Infinity)));
r.join(' || ')
// ---
// Holes filled from the prototype chain at depth on the generic path, and a nested sparse
// array with a huge length whose present indices are found by the skip.
Array.prototype[1] = ['proto', ['deep']];
var sparse = []; sparse[4e9] = 'far'; sparse[5] = [5];
var a = [[0, , 2], new Proxy([, , [, 'x']], {}), sparse.length > 1 ? [[sparse]] : 0];
var out;
try { out = JSON.stringify(a.flat(Infinity)); } finally { delete Array.prototype[1]; }
out
// ---
// The fast-path check's budget at exactly 1,024 visits, with a disqualifier placed as the
// last element visited, just past the budget, and below the requested depth.
function wide(w, leaf) { var b = [1]; var a = []; for (var i = 0; i < w; i++) a.push(b); a.push(leaf); return a; }
var acc = [0]; Object.defineProperty(acc, '0', { get: function () { return 'acc'; } });
var px = new Proxy([0], {});
var r = [];
[[1022, [acc]], [1023, [acc]], [1022, [[px]]], [1022, px], [1021, [[1]]], [1022, [[1]]], [1023, 9]].forEach(function (c) {
  var a = wide(c[0], c[1]);
  [0, 1, 2, 3].forEach(function (d) { var f = a.flat(d); r.push(f.length + ':' + String(f[f.length - 1])); });
});
r.join()
// ---
// The fast path over DAGs that share a subtree at many depths, with depths around the share.
var leaf = [1, [2, [3, [4]]]];
var a = [leaf];
for (var i = 0; i < 9; i++) a = [a, leaf, a];
var r = [];
[0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 20, Infinity].forEach(function (d) { var f = a.flat(d); r.push(f.length); });
r.join()
// ---
// A nested source whose length is past the linear cap's reach only in total: each Proxy source
// takes 2^24 - 1 probes, the two together more than 2^24. The cap is per source.
var t1 = []; t1.length = (1 << 24) - 1; t1[0] = 'a';
var t2 = []; t2.length = (1 << 24) - 1; t2[7] = 'b';
var p1 = new Proxy(t1, {});
var p2 = new Proxy(t2, {});
var outer = new Proxy([p1, 'mid', p2], {});
JSON.stringify([outer].flat(Infinity))
// ---
// A single Proxy source one past the linear cap is refused, after an outer source spent probes.
var t1 = []; t1.length = (1 << 24) + 1;
var outer = new Proxy([0, 1, new Proxy(t1, {})], {});
[outer].flat(Infinity).length
// ---
// A get trap that reports a huge length on a nested Proxy, refused by the cap on that source.
var t = [1, 2];
var big = new Proxy(t, { get: function (o, k) { return k === 'length' ? 2 ** 53 + 10 : o[k]; } });
[0, [big]].flat(Infinity).length
// ---
// A resource refusal decided at depth in the generic walk: five million leaves under 1,500
// open sources exhaust the property key space while the target grows.
var filler = 'a'.repeat(2 ** 25);
var w = [];
for (var i = 0; i < 5e6; i++) w.push(i);
var acc = [0]; Object.defineProperty(acc, '0', { get: function () { return 'g'; } });
var a = [w, acc];
for (var i = 0; i < 1500; i++) a = [a, new Proxy([], {})];
var r;
try { r = a.flat(Infinity).length; } catch (e) { r = e.name + ':' + e.message; }
r
