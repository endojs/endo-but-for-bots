// B1, alternating Proxy and ordinary chains, from the pre-commit re-review.
// The Array Iterator's residual context reached by a forward inside the index [[Get]] loop:
// the trap reads through P0, an untrapped Proxy whose target is the context target.
var a = [3, 4, 5];
var inner = new Proxy(new Proxy(a, {}), {});
var P0 = new Proxy(new Proxy(inner, {}), {});
var top = new Proxy(inner, { get: function (t, k, r) { return Reflect.get(P0, k, r); } });
Array.from(Array.prototype.values.call(top)).join()
// ---
// B1 v2 review: as above, over an array-like whose index properties are kept by index, with an
// ordinary level between P0 and the context target.
var o = { length: 3, 0: 'a', 1: 'b', 2: 'c' };
var inner = new Proxy(new Proxy(o, {}), {});
var P0 = new Proxy(Object.create(inner), {});
var top = new Proxy(inner, { get: function (t, k, r) { return Reflect.get(P0, k, r); } });
[Array.from(Array.prototype.values.call(top)).join(), Array.prototype.join.call(top)].join('|')
// ---
// B1 v2 review: the context target reached at the end of an alternating chain inside the trap,
// over a String wrapper (terminal-wrapper metering).
var s = new String('xyz');
var inner = new Proxy(new Proxy(s, {}), {});
var mid = inner;
for (var i = 0; i < 9; i++) mid = i % 2 ? Object.create(mid) : new Proxy(mid, {});
var top = new Proxy(inner, { get: function (t, k, r) { return Reflect.get(mid, k, r); } });
Array.from(Array.prototype.values.call(top)).join()
// ---
// B1 v2 review: [[HasProperty]] around a prototype cycle through a Proxy (P -> O -> P ...):
// every lap is one unit, so the walk halts at the budget at the same depth.
var o = {};
var p = new Proxy(o, {});
Object.setPrototypeOf(o, p);
'x' in p
// ---
// B1 v2 review: index-keyed [[HasProperty]] around a Proxy prototype cycle.
var o = {};
var p = new Proxy(o, {});
Object.setPrototypeOf(o, p);
923456789 in p
// ---
// B1 v2 review: index-keyed [[Get]] around a Proxy prototype cycle.
var o = {};
var p = new Proxy(o, {});
Object.setPrototypeOf(o, p);
p[923456789]
// ---
// B1 v2 review: id-keyed [[Get]] around a Proxy prototype cycle of two untrapped layers.
var o = {};
var p = new Proxy(new Proxy(o, {}), {});
Object.setPrototypeOf(o, p);
p.nope
// ---
// B1 v2 review: [[Set]] around a Proxy prototype cycle.
var o = {};
var p = new Proxy(new Proxy(o, {}), {});
Object.setPrototypeOf(o, p);
p.nope = 1
// ---
// B1 v2 review: the Array Iterator's length read around a Proxy prototype cycle.
var o = {};
var p = new Proxy(new Proxy(o, {}), {});
Object.setPrototypeOf(o, p);
Array.prototype.values.call(p).next()
// ---
// B1 v2 review: a has trap at the end of a cycle: the trap sees the key after every lap's levels.
var n = 0;
var o = {};
var q = new Proxy({}, { has: function (t, k) { n++; return false; } });
var p = new Proxy(o, {});
Object.setPrototypeOf(o, q);
['x' in p, 923456789 in p, n].join()
// ---
// B1 v2 review: unit-leak probe for the v2 loops: caught errors thrown from deep inside the has,
// index-has and index-get loops (revoked bottom, throwing trap, throwing handler getter,
// invariant violation), then an alternating has chain at exactly its ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = Proxy.revocable({}, {}); r.revoke();
var boom = function () { throw new RangeError('b'); };
var bottoms = [
  Object.create(r.proxy),
  new Proxy({}, { has: boom, get: boom }),
  new Proxy({}, { get has() { throw new RangeError('g'); }, get get() { throw new RangeError('g'); } }),
  new Proxy(Object.preventExtensions(Object.defineProperty({}, 923456789, { value: 1 })), { has: function () { return false; } }),
];
var caught = {};
for (var round = 0; round < 30; round++) {
  bottoms.forEach(function (b) {
    var p = alt(b, 41);
    [function () { return 'x' in p; }, function () { return 923456789 in p; }, function () { return p[923456789]; },
     function () { return p.x; }, function () { with (p) { return x; } }].forEach(function (op) {
      try { op(); } catch (e) { caught[e.message] = (caught[e.message] || 0) + 1; }
    });
  });
}
var q = alt({ x: 1 }, 4063);
[JSON.stringify(caught), 'x' in q].join('|')
// ---
// B1 v2 review: the same leak probe ending with an index-keyed [[Get]] at its ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = Proxy.revocable({}, {}); r.revoke();
var p = alt(Object.create(r.proxy), 61);
var caught = 0;
for (var round = 0; round < 50; round++) {
  try { p[923456789]; } catch (e) { caught++; }
  try { 923456789 in p; } catch (e) { caught++; }
  try { Object.getOwnPropertyDescriptor(p, 923456789); } catch (e) { caught++; }
  try { delete p[923456789]; } catch (e) { caught++; }
}
var a = []; a[923456789] = 7;
var q = alt(a, 4062);
[caught, q[923456789]].join()
// ---
// B1 v2 review: the same, one layer past the index [[Get]] ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = Proxy.revocable({}, {}); r.revoke();
var p = alt(Object.create(r.proxy), 61);
var caught = 0;
for (var round = 0; round < 50; round++) {
  try { p[923456789]; } catch (e) { caught++; }
  try { 923456789 in p; } catch (e) { caught++; }
}
var a = []; a[923456789] = 7;
var q = alt(a, 4063);
[caught, q[923456789]].join()
// ---
// B1 v2 review: the Get loop's forwarded metering: caught errors from an Array Iterator read
// whose trap throws below several untrapped layers, then a values() chain at its ceiling.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var bad = wrap(new Proxy([1, 2], { get: function (t, k) { if (k === '1') throw new RangeError('k'); return Reflect.get(t, k); } }), 5);
var caught = 0;
for (var i = 0; i < 40; i++) { try { [...bad]; } catch (e) { caught++; } }
var p = wrap([1, 2], 1998);
[caught, Array.from(Array.prototype.values.call(p)).join()].join('|')
// ---
// B1 v2 review: one layer past the values() chain ceiling after the same errors.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var bad = wrap(new Proxy([1, 2], { get: function (t, k) { if (k === '1') throw new RangeError('k'); return Reflect.get(t, k); } }), 5);
var caught = 0;
for (var i = 0; i < 40; i++) { try { [...bad]; } catch (e) { caught++; } }
var p = wrap([1, 2], 1999);
[caught, Array.from(Array.prototype.values.call(p)).join()].join('|')
// ---
// B1 v2 review: a handler getter that rewires the chain below it mid-walk: the levels after the
// forward must see the new prototype, and the next layer's revocation must be observed in order.
var log = [];
var r = Proxy.revocable({ y: 1 }, {});
var o = Object.create(new Proxy({ x: 1 }, {}));
var swap = { get has() { log.push('has'); Object.setPrototypeOf(o, r.proxy); return undefined; },
             get get() { log.push('get'); r.revoke(); return undefined; } };
var p = new Proxy(o, swap);
var out = [];
try { out.push('x' in p); } catch (e) { out.push(e.message); }
try { out.push(p.y); } catch (e) { out.push(e.message); }
try { out.push(923456789 in p); } catch (e) { out.push(e.message); }
[out.join(), log.join()].join('|')
// ---
// B1 v2 review: handler getters logged across an alternating chain, for every method that walks
// ordinary levels between layers (has, get, index has, index get, set, with).
var log = [];
function H(n) { return new Proxy({}, { get: function (t, k) { log.push(n + ':' + String(k)); return undefined; } }); }
var p = { x: 1 }; p[923456789] = 2;
for (var i = 0; i < 12; i++) p = i % 2 ? Object.create(p) : new Proxy(p, H(i));
var r = ['x' in p, 'z' in p, 923456789 in p, 923456788 in p, p.x, p[923456789], p[923456788]];
p.w = 3;
with (p) { r.push(x); x = 4; }
[r.join(), log.join()].join('|')
// ---
// B1 v2 review: `in` frame metering of the first leg, with ordinary levels above the first Proxy
// and an alternating chain below it, hit and miss, id and index keys.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var a = []; a[923456789] = 1; a.k = 1;
var p = Object.create(Object.create(Object.create(alt(a, 33))));
['k' in p, 'nope' in p, 923456789 in p, 923456788 in p, 0 in p, Reflect.has(p, 'k')].join()
// ---
// B1 v2 review: a trapped has at the bottom of an alternating chain answering through an
// invariant check on a non-configurable target property.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var t = Object.defineProperty({}, 'nc', { value: 1, configurable: false });
Object.defineProperty(t, 923456789, { value: 1, configurable: false });
var p = alt(new Proxy(t, { has: function () { return false; } }), 25);
var out = [];
try { out.push('nc' in p); } catch (e) { out.push(e.message); }
try { out.push(923456789 in p); } catch (e) { out.push(e.message); }
out.join()
// ---
// B1 v2 review: a trapped get at the bottom of an alternating chain answering through an
// invariant check (index and id keys).
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var t = Object.defineProperty({}, 'nc', { value: 1, configurable: false, writable: false });
Object.defineProperty(t, 923456789, { value: 1, configurable: false, writable: false });
var p = alt(new Proxy(t, { get: function () { return 2; } }), 25);
var out = [];
try { out.push(p.nc); } catch (e) { out.push(e.message); }
try { out.push(p[923456789]); } catch (e) { out.push(e.message); }
out.join()
// ---
// B1 v2 review: Array Iterator reads where a trapped layer sits between untrapped layers and an
// ordinary level, so the forwarded flag turns on mid-loop and the terminal is a wrapper.
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var w = new String('ab');
var p = new Proxy(new Proxy(Object.create(new Proxy(new Proxy(w, {}), RG)), {}), {});
var q = new Proxy(new Proxy(new Proxy(new Proxy(w, {}), {}), RG), {});
[Array.from(Array.prototype.values.call(p)).length, Array.from(Array.prototype.values.call(q)).join()].join('|')
// ---
// B1 v2 review: Array Iterator over a Proxy chain whose terminal is a Symbol and a BigInt wrapper
// below a trapped layer (the wide-primitive receiver tick after forwarding).
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var s = new Proxy(new Proxy(new Proxy(Object(Symbol('q')), {}), RG), {});
var b = new Proxy(new Proxy(new Proxy(Object(5n), {}), {}), RG);
[Array.from(Array.prototype.values.call(s)).length, Array.from(Array.prototype.values.call(b)).length].join()
// ---
// B1 v2 review: an alternating has chain at its exact ceiling under a re-entrant handler getter
// that runs a short has walk at every layer.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var inner = wrap({ y: 1 }, 6);
var h = { get has() { 'y' in inner; return undefined; } };
var p = { x: 1 };
for (var i = 0; i < 2010; i++) p = new Proxy(p, h);
'x' in p
// ---
// B1 v2 review: one layer past that ceiling.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var inner = wrap({ y: 1 }, 6);
var h = { get has() { 'y' in inner; return undefined; } };
var p = { x: 1 };
for (var i = 0; i < 2011; i++) p = new Proxy(p, h);
'x' in p
// ---
// B1 v2 review: P -> O -> O alternation for `in`, at its ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 3 ? Object.create(o) : new Proxy(o, {}); return o; }
var p = alt({ x: 1 }, 6094);
['x' in p, 'nope' in p].join()
// ---
// B1 v2 review: P -> O -> O alternation for `in`, one level past its ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 3 ? Object.create(o) : new Proxy(o, {}); return o; }
var p = alt({ x: 1 }, 6095);
['x' in p, 'nope' in p].join()
// ---
// B1 v2 review: P -> O -> O alternation for the index [[Get]] and `in`, near the ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 3 ? Object.create(o) : new Proxy(o, {}); return o; }
var a = []; a[923456789] = 9;
var p = alt(a, 6093);
[p[923456789], 923456789 in p, p[923456788]].join()
// ---
// B1 v2 review: P -> O -> O alternation for the index [[Get]] and `in`, one level past.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 3 ? Object.create(o) : new Proxy(o, {}); return o; }
var a = []; a[923456789] = 9;
var p = alt(a, 6094);
[p[923456789], 923456789 in p, p[923456788]].join()
// ---
// B1 v2 review: the alternating has walk at its ceiling and one past it.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var p = alt({ x: 1 }, 4063), q = alt({ x: 1 }, 4064);
var out = ['x' in p];
out.push('x' in q);
out.join()
// ---
// B1 v2 review: getOwnPropertyDescriptor / delete / defineProperty chains whose terminal is an
// ordinary object reached after an alternating prefix, with a revoked layer met half way.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var r = Proxy.revocable({ x: 1 }, {});
var p = wrap(wrap(r.proxy, 30), 30);
var ops = [function () { return JSON.stringify(Object.getOwnPropertyDescriptor(p, 'x')); },
  function () { return JSON.stringify(Object.getOwnPropertyDescriptor(p, 923456789)); },
  function () { return delete p.x; }, function () { return delete p[923456789]; },
  function () { return Reflect.defineProperty(p, 'z', { value: 1 }); },
  function () { return Reflect.ownKeys(p).join(); }, function () { return Object.isExtensible(p); },
  function () { return Reflect.getPrototypeOf(p) === Object.prototype; }];
var out = ops.map(function (f) { try { return f(); } catch (e) { return e.message; } });
r.revoke();
out = out.concat(ops.map(function (f) { try { return f(); } catch (e) { return e.message; } }));
out.join('|')
// ---
// B1 v2 review: whole-object walkers over an alternating chain: JSON.stringify, object spread,
// Object.assign and for-in, each mixing [[OwnPropertyKeys]], [[GetOwnProperty]],
// [[GetPrototypeOf]] and [[Get]] forwards.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var base = { a: 1, b: [2, 3] }; base[923456789] = 4;
var p = new Proxy(alt(base, 40), {});
var keys = [];
for (var k in p) keys.push(k);
[JSON.stringify(p), JSON.stringify({ ...p }), JSON.stringify(Object.assign({}, p)), keys.join()].join('|')
// ---
// B1 v2 review: symbol keys and Reflect.set with a foreign receiver through an alternating chain.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var s = Symbol('k');
var base = { x: 1 }; base[s] = 2;
var p = alt(base, 101);
var other = {};
[s in p, p[s], Symbol.iterator in p, Reflect.set(p, 'x', 5, other), other.x, Reflect.set(p, s, 6, other), other[s],
 Reflect.set(p, 923456789, 7, other), other[923456789]].map(String).join()
// ---
// B1 v2 review: uninterned index [[Set]] through an alternating chain to an array, at the
// [[Set]] ceiling and one past it.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var a = []; a[923456789] = 1;
var out = [];
var p = alt(a, 2030);
p[923456788] = 2;
out.push(a[923456788], p[923456788]);
var q = alt(a, 2031);
q[923456787] = 3;
out.join()
// ---
// B1 v2 review: [[Call]] from the dispatch path (RUN) for every forward-metering class
// of target, one and three layers deep, with and without an apply trap at the top.
var m = new Map([[1, 2]]);
var targets = [function u(a) { return 'u' + a; }, (function (a, b) { return 'b' + a + b; }).bind(null, 'B'),
  Math.max, String.prototype.toUpperCase, m.forEach.bind(m), m.forEach, Array.prototype.join];
var log = [];
var trap = { apply: function (t, th, args) { log.push(typeof th + ':' + args.length); return Reflect.apply(t, th, args); } };
var out = [];
targets.forEach(function (t) {
  [new Proxy(t, {}), new Proxy(new Proxy(new Proxy(t, {}), {}), {}), new Proxy(t, trap), new Proxy(new Proxy(t, {}), trap)]
    .forEach(function (p) { try { out.push(String(p(1, 2))); } catch (e) { out.push(e.name); } });
});
[out.join(), log.join()].join('|')
// ---
// B1 v2 review: [[Call]] through invoke_value (callbacks, Reflect.apply, call/apply trampolines)
// over Proxy chains mixing trapped and untrapped layers over a bound target, and a bound `call`
// whose receiver is the chain.
function f() { return [typeof this, arguments.length].join(); }
var trap = { apply: function (t, th, a) { return Reflect.apply(t, th, a); } };
var p = f.bind(null, 'b0').bind(null, 'b1');
for (var i = 0; i < 30; i++) p = new Proxy(p, i % 5 === 4 ? trap : {});
var bp = Function.prototype.call.bind(p);
[[1].map(p).join(), Reflect.apply(p, 'th', [1, 2]), p.call(null, 3), Function.prototype.apply.call(p, 1, [4, 5]),
 Function.prototype.call.call(p, 'x'), bp('t', 6), [7].map(bp).join()].join('|')
// ---
// B1 v2 review: a revoked layer and a throwing apply trap below the dispatch path's first layer,
// many times, then a call chain at its ceiling.
var r = Proxy.revocable(function () {}, {}); r.revoke();
var bad = new Proxy(new Proxy(new Proxy(function () {}, { apply: function () { throw new RangeError('a'); } }), {}), {});
var rev = new Proxy(new Proxy(r.proxy, {}), {});
var msgs = {};
for (var i = 0; i < 60; i++) {
  [bad, rev].forEach(function (q) { try { q(); } catch (e) { msgs[e.message] = (msgs[e.message] || 0) + 1; } });
  try { Reflect.apply(rev, null, []); } catch (e) { msgs['R' + e.message] = (msgs['R' + e.message] || 0) + 1; }
}
var g = function () { return 'ok'; };
for (var i = 0; i < 2016; i++) g = new Proxy(g, {});
[JSON.stringify(msgs), g()].join('|')
// ---
// B1 v2 review: the same, one layer past the call chain's ceiling.
var g = function () { return 'ok'; };
for (var i = 0; i < 2017; i++) g = new Proxy(g, {});
g()
// ---
// B1 v2 review: apply traps at every other layer of a dispatch-path call, near its ceiling.
var trap = { apply: function (t, th, a) { return Reflect.apply(t, th, a); } };
var g = function () { return arguments.length; };
for (var i = 0; i < 230; i++) g = new Proxy(g, i % 2 ? trap : {});
g(1, 2, 3)
