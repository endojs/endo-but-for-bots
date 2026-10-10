// B1, adversarial programs from the pre-commit review.
// Unit-leak probe: many caught errors from inside deep forwarding walks of every internal
// method (trap throws below N layers), then a get chain at exactly its ceiling.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function boom() { throw new RangeError('boom'); }
var H = { get: boom, set: boom, has: boom, deleteProperty: boom, ownKeys: boom,
  getOwnPropertyDescriptor: boom, defineProperty: boom, getPrototypeOf: boom, setPrototypeOf: boom,
  isExtensible: boom, preventExtensions: boom, apply: boom, construct: boom };
var p = wrap(new Proxy(function () {}, H), 50);
var ops = [
  function () { return p.x; }, function () { p.x = 1; }, function () { return 'x' in p; },
  function () { return delete p.x; }, function () { return Object.keys(p); },
  function () { return Object.getOwnPropertyDescriptor(p, 'x'); }, function () { Object.defineProperty(p, 'x', { value: 1 }); },
  function () { return Object.getPrototypeOf(p); }, function () { return Object.setPrototypeOf(p, null); },
  function () { return Object.isExtensible(p); }, function () { return Object.preventExtensions(p); },
  function () { return p[123456789]; }, function () { return 123456788 in p; }, function () { return delete p[123456787]; },
  function () { return Object.getOwnPropertyDescriptor(p, 123456786); },
  function () { return p(); }, function () { return new p(); },
];
var caught = 0;
for (var round = 0; round < 40; round++) {
  ops.forEach(function (op) { try { op(); } catch (e) { if (e instanceof RangeError) caught++; } });
}
var q = { x: 1 };
for (var i = 0; i < 2032; i++) q = new Proxy(q, {});
[caught, q.x].join()
// ---
// Unit-leak probe: revoked layers at depth, for every method, many times, then a call chain at
// its ceiling.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var rv = Proxy.revocable(function () {}, {});
rv.revoke();
var p = wrap(rv.proxy, 60);
var ops = [
  function () { return p.x; }, function () { p.x = 1; }, function () { return 'x' in p; },
  function () { return delete p.x; }, function () { return Object.keys(p); },
  function () { return Object.getOwnPropertyDescriptor(p, 'x'); }, function () { Object.defineProperty(p, 'x', { value: 1 }); },
  function () { return Object.getPrototypeOf(p); }, function () { return Object.setPrototypeOf(p, null); },
  function () { return Object.isExtensible(p); }, function () { return Object.preventExtensions(p); },
  function () { return p[123456789]; }, function () { return 123456788 in p; }, function () { return delete p[123456787]; },
  function () { return p(); }, function () { return new p(); }, function () { return Reflect.apply(p, null, []); },
  function () { return Reflect.construct(p, []); },
];
var msgs = {};
for (var round = 0; round < 40; round++) {
  ops.forEach(function (op) { try { op(); } catch (e) { msgs[e.message] = (msgs[e.message] || 0) + 1; } });
}
var f = function () { return 'called'; };
for (var i = 0; i < 2016; i++) f = new Proxy(f, {});
[JSON.stringify(msgs), f()].join()
// ---
// Unit-leak probe: errors thrown at the terminal of the walk (getter, setter, target function,
// target constructor), and invariant violations from traps at depth; then a has chain at its
// ceiling.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function boom() { throw new RangeError('t'); }
var base = Object.defineProperty({}, 'g', { get: boom, set: boom });
var nc = Object.defineProperty({}, 'k', { value: 1, configurable: false });
var lie = wrap(new Proxy(nc, { get: function () { return 2; }, has: function () { return false; },
  deleteProperty: function () { return true; }, getOwnPropertyDescriptor: function () { return undefined; },
  ownKeys: function () { return []; } }), 40);
var p = wrap(base, 70), fp = wrap(boom, 70);
var n = 0;
for (var round = 0; round < 60; round++) {
  try { p.g; } catch (e) { n++; }
  try { p.g = 1; } catch (e) { n++; }
  try { fp(); } catch (e) { n++; }
  try { new fp(); } catch (e) { n++; }
  try { lie.k; } catch (e) { n++; }
  try { 'k' in lie; } catch (e) { n++; }
  try { delete lie.k; } catch (e) { n++; }
  try { Object.getOwnPropertyDescriptor(lie, 'k'); } catch (e) { n++; }
  try { Object.keys(lie); } catch (e) { n++; }
}
var q = { x: 1 };
for (var i = 0; i < 2032; i++) q = new Proxy(q, {});
[n, 'x' in q].join()
// ---
// Unit-leak probe, then one past the ceiling: the halt depth must match.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function boom() { throw new RangeError('t'); }
var p = wrap(new Proxy({}, { get: boom }), 100);
for (var round = 0; round < 100; round++) { try { p.x; } catch (e) {} }
var q = { x: 1 };
for (var i = 0; i < 2033; i++) q = new Proxy(q, {});
q.x
// ---
// The depth a trap runs at: inside a get trap under N layers, a forEach recursion (heavy
// frames) runs until the budget halts; the count of levels reached is in the meter.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var p = wrap(new Proxy({}, { get: function () { r(); } }), 37);
p.x
// ---
// The depth an apply trap runs at, through layers and a bound trap.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var p = wrap(new Proxy(function () {}, { apply: function () { r(); }.bind(null) }), 41);
p()
// ---
// The depth a construct trap runs at.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var p = wrap(new Proxy(function () {}, { construct: function () { r(); } }), 23);
new p()
// ---
// The depth a has trap runs at, behind ordinary levels.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var p = Object.create(Object.create(wrap(new Proxy({}, { has: function () { r(); } }), 19)));
'x' in p
// ---
// The depth an index get trap (uninterned key) runs at.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var p = Object.create(wrap(new Proxy([], { get: function () { r(); } }), 29));
p[987654321]
// ---
// The depth of the target function reached through layers and a bound fold.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var p = wrap(wrap(wrap(r, 5).bind(null), 7).bind(null, 1), 9);
p()
// ---
// [[Call]] argument ownership: call/apply trampolines feeding proxies feeding bound functions
// feeding trampolines, and traps that are bound, proxied, or Function.prototype.call/apply.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f() { return [this === undefined ? 'u' : String(this), Array.prototype.join.call(arguments, '.')].join('|'); }
var call = Function.prototype.call, apply = Function.prototype.apply;
var r = [];
r.push(call.call(wrap(f.bind('b', 1), 3), 'ignored', 2, 3));
r.push(apply.call(wrap(f.bind('b', 1, 2), 3), 'ignored', [3, 4]));
r.push(Reflect.apply(wrap(call, 4), wrap(f, 2), ['T', 5, 6]));
r.push(Reflect.apply(wrap(apply, 4), wrap(f.bind('B'), 2), ['T', [7, 8]]));
r.push(wrap(call.bind(wrap(f.bind('x', 'y'), 2)), 3)('this', 'z'));
r.push(wrap(apply.bind(wrap(f, 2), 'A'), 3)([1, 2, 3]));
var c = f; for (var i = 0; i < 6; i++) c = wrap(call.bind(c), 1);
r.push(c('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'));
var h1 = function () { return 'h1:' + (this === f) + ':' + arguments.length; };
h1.apply = call;
r.push(wrap(new Proxy(f, h1), 2)(1, 2));
var h2 = function () { return 'h2:' + (this === f) + ':' + arguments.length; }.bind(null, 'pre');
h2.apply = call;
r.push(wrap(new Proxy(f, h2), 2)(1, 2));
var h3 = function (a, b) { return 'h3:' + (this === f) + ':' + arguments.length; };
h3.apply = apply;
r.push(wrap(new Proxy(f, h3), 2)(1, 2));
r.push(wrap(new Proxy(wrap(f, 2), { apply: Reflect.apply.bind(null) }), 2)(9, 8));
r.push(wrap(new Proxy(wrap(f, 2), { apply: wrap(function (t, th, a) { return 'pt:' + Reflect.apply(t, th, a); }, 5) }), 2)(4));
r.push(wrap(new Proxy(wrap(f, 2), { apply: wrap(function (t, th, a) { return 'bpt:' + Reflect.apply(t, th, a); }.bind(null), 5) }), 2).call('C', 4));
r.push([3, 1, 2].sort(wrap(function (a, b) { return a - b; }.bind(null), 4)).join());
r.join(' ; ')
// ---
// [[Call]] through layers with very long argument lists (scratch reservation sizes), and bound
// prefixes at several levels of proxy/bound alternation.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function count() { return arguments.length + ':' + arguments[0] + ':' + arguments[arguments.length - 1]; }
var g = count;
for (var i = 0; i < 30; i++) g = wrap(g.bind(null, i), 2);
var big = []; for (var i = 0; i < 3000; i++) big.push(i);
[g(), g.apply(null, big), Reflect.apply(g, null, big), Function.prototype.apply.call(g, null, big)].join(' ; ')
// ---
// [[Call]] alternating proxy and bound wrappers up to and past the budget.
function count() { return arguments.length; }
var g = count;
for (var i = 0; i < 2010; i++) g = i % 3 === 0 ? g.bind(null, i) : new Proxy(g, {});
var r = [g(1)];
for (var i = 0; i < 20; i++) g = new Proxy(g, {});
try { r.push(g(1)); } catch (e) { r.push(e.name); }
r.join()
// ---
// [[Construct]] through layers: newTarget proxies, derived classes over proxies, natives under
// proxies, a bound target under proxies, construct traps that are proxies and bound.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
function F(a) { this.a = a; log.push(typeof new.target, new.target === NT); }
function NT() {}
NT.prototype = { kind: 'nt' };
var r = [];
var o = Reflect.construct(wrap(F, 5), [1], wrap(NT, 3));
r.push(o.a, Object.getPrototypeOf(o) === NT.prototype);
class A { constructor(x) { this.x = x; this.nt = new.target.name; } }
class B extends wrap(A, 6) { constructor() { super(7); this.b = 1; } }
var b = new B();
r.push(b.x, b.nt, b.b, b instanceof B, b instanceof A);
r.push(new (wrap(Array, 4))(3).length, new (wrap(Map, 4))([[1, 2]]).get(1), Reflect.construct(wrap(Array, 3), [2], wrap(NT, 2)) instanceof Array);
try { r.push(new (wrap(F.bind(null, 9), 3))().a); } catch (e) { r.push('bound:' + e.name); }
var pt = wrap(new Proxy(wrap(F, 2), { construct: wrap(function (t, args, nt) { return Reflect.construct(t, args, nt); }, 4) }), 3);
r.push(new pt(5).a);
var bt = wrap(new Proxy(wrap(F, 2), { construct: function (t, args, nt) { return Reflect.construct(t, args, nt); }.bind(null) }), 3);
r.push(new bt(6).a);
r.push(log.join('/'));
r.join()
// ---
// [[Construct]] alternating chains up to the budget, with a construct trap at the bottom.
function F() { this.v = 1; }
var p = new Proxy(F, { construct: function (t, a, nt) { return Reflect.construct(t, a, nt); } });
for (var i = 0; i < 1000; i++) p = new Proxy(p, {});
var r = [new p().v];
p = new Proxy(p, { construct: function (t, a, nt) { return Reflect.construct(t, a, nt); } });
for (var i = 0; i < 1000; i++) p = new Proxy(p, {});
try { r.push(new p().v); } catch (e) { r.push(e.name); }
r.join()
// ---
// Every trap lookup through handler getters that log and, at one layer, revoke a deeper proxy
// mid-walk.
function make(names) {
  var log = [];
  var inner = Proxy.revocable(function () { return 1; }, {});
  var p = inner.proxy;
  for (var i = 0; i < 8; i++) {
    var h = {};
    names.forEach(function (n) {
      Object.defineProperty(h, n, { get: (function (i) { return function () { log.push(n + i); if (i === 5 && n === names[0]) inner.revoke(); return undefined; }; })(i) });
    });
    p = new Proxy(p, h);
  }
  return { p: p, log: log };
}
var cases = [
  ['get', function (p) { return p.x; }], ['set', function (p) { p.x = 1; }], ['has', function (p) { return 'x' in p; }],
  ['deleteProperty', function (p) { return delete p.x; }], ['ownKeys', function (p) { return Object.keys(p); }],
  ['getOwnPropertyDescriptor', function (p) { return Object.getOwnPropertyDescriptor(p, 'x'); }],
  ['defineProperty', function (p) { return Reflect.defineProperty(p, 'x', { value: 1 }); }],
  ['getPrototypeOf', function (p) { return Object.getPrototypeOf(p); }], ['setPrototypeOf', function (p) { return Reflect.setPrototypeOf(p, null); }],
  ['isExtensible', function (p) { return Object.isExtensible(p); }], ['preventExtensions', function (p) { return Reflect.preventExtensions(p); }],
  ['apply', function (p) { return p(); }], ['construct', function (p) { return new p(); }],
  ['get', function (p) { return p[223456789]; }], ['has', function (p) { return 223456788 in p; }],
  ['deleteProperty', function (p) { return delete p[223456787]; }],
];
var r = [];
cases.forEach(function (c) {
  var m = make([c[0]]);
  try { c[1](m.p); r.push('ok'); } catch (e) { r.push(e.message); }
  r.push(m.log.join('/'));
});
r.join(' ; ')
// ---
// getPrototypeOf through handlers whose trap is a non-callable (the untick credit), a throwing
// getter, and a throwing trap, at depth, via instanceof and isPrototypeOf too.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function F() {}
var r = [];
var bad = wrap(new Proxy(new F(), { getPrototypeOf: 5 }), 9);
var thr = wrap(new Proxy(new F(), { get getPrototypeOf() { throw new EvalError('g'); } }), 9);
var trapThr = wrap(new Proxy(new F(), { getPrototypeOf: function () { throw new URIError('t'); } }), 9);
[bad, thr, trapThr].forEach(function (p) {
  try { Object.getPrototypeOf(p); r.push('ok'); } catch (e) { r.push(e.name); }
  try { r.push(p instanceof F); } catch (e) { r.push(e.name); }
  try { r.push(F.prototype.isPrototypeOf(p)); } catch (e) { r.push(e.name); }
  try { r.push(Object.create(p) instanceof F); } catch (e) { r.push(e.name); }
});
r.join()
// ---
// [[HasProperty]] frame counts through `with`: ordinary levels, then proxies, then more ordinary
// levels behind the proxy target, for a hit, a miss, and an assignment (SetMutableBinding).
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var deep = Object.create(Object.create(Object.create({ hit: 'H' })));
var mid = Object.create(Object.create(wrap(Object.create(Object.create(wrap(deep, 4))), 6)));
var top = Object.create(Object.create(Object.create(mid)));
var r = [];
with (top) { r.push(hit); r.push(typeof miss); hit = 'set'; }
var trapped = Object.create(Object.create(wrap(new Proxy(Object.create(deep), { has: function (t, k) { r.push('has:' + String(k)); return k in t; } }), 3)));
with (trapped) { r.push(hit); r.push(typeof r); }
r.push(deep.hit, Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf(deep))).hit);
r.join()
// ---
// [[HasProperty]] with index keys through ordinary levels and proxies, metered by `with` and `in`.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var base = Object.create(Object.create([1, 2, 3]));
var p = Object.create(Object.create(wrap(Object.create(wrap(base, 3)), 4)));
var ta = Object.create(wrap(Object.create(wrap(new Uint8Array(5), 2)), 2));
var s = Object.create(wrap(Object.create(wrap(new String('hello'), 2)), 2));
[2 in p, 3 in p, 323456789 in p, 4 in ta, 5 in ta, 423456789 in ta, 4 in s, 5 in s, 523456789 in s,
 Reflect.has(p, 1), Reflect.has(ta, 623456789)].join()
// ---
// Index keys (never interned) behind layers: get, has, own descriptor, delete, on arrays,
// typed arrays, string wrappers, ordinary index stores, with get/has/gopd/delete traps below.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
var trapH = { get: function (t, k, r) { log.push('g' + k); return Reflect.get(t, k, r); },
  has: function (t, k) { log.push('h' + k); return Reflect.has(t, k); },
  getOwnPropertyDescriptor: function (t, k) { log.push('o' + k); return Reflect.getOwnPropertyDescriptor(t, k); },
  deleteProperty: function (t, k) { log.push('d' + k); return Reflect.deleteProperty(t, k); } };
var arr = []; arr[723456789] = 'big';
var o = {}; o[823456789] = 'obj';
var targets = [arr, new Float64Array(3), new String('abc'), o];
var r = [];
targets.forEach(function (t) {
  var p = wrap(new Proxy(wrap(t, 3), trapH), 3);
  r.push(p[723456789], p[823456789], p[2], 723456789 in p, 823456789 in p,
    JSON.stringify(Reflect.getOwnPropertyDescriptor(p, 723456789)), delete p[823456789], delete p[2]);
});
r.push(log.join('/'));
r.join()
// ---
// The Array Iterator's residual through forwarded layers over every receiver kind, with a get
// trap at the top, in the middle, and at the bottom.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function trap(o) { return new Proxy(o, { get: function (t, k, r) { return Reflect.get(t, k, r); } }); }
var shapes = [function () { return [1, 2, 3]; }, function () { return new Int16Array([4, 5]); },
  function () { return new String('xy'); }, function () { return { length: 2, 0: 'a', 1: 'b' }; },
  function () { return Object(Symbol('s')); }];
var r = [];
shapes.forEach(function (mk, si) {
  [wrap(trap(wrap(mk(), 3)), 3), trap(wrap(mk(), 5)), wrap(trap(mk()), 5), wrap(mk(), 6)].forEach(function (p) {
    try {
      var out = [];
      for (var v of Array.prototype.values.call(p)) out.push(String(v));
      r.push(out.join(':'));
      r.push(Array.from(Array.prototype.entries.call(p)).length);
    } catch (e) { r.push(e.name); }
  });
});
r.join()
// ---
// [[Call]] argument ownership: call/apply trampolines feeding proxies feeding bound functions
// feeding trampolines, and traps that are bound, proxied, or Function.prototype.call/apply.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f() { var t = this === undefined ? 'u' : (typeof this === 'object' || typeof this === 'function') ? typeof this : this; return [t, Array.prototype.join.call(arguments, '.')].join('|'); }
var call = Function.prototype.call, apply = Function.prototype.apply;
var r = [];
function tryit(fn) { try { r.push(fn()); } catch (e) { r.push(e.name + ':' + e.message); } }
tryit(function () { return call.call(wrap(f.bind('b', 1), 3), 'ignored', 2, 3); });
tryit(function () { return apply.call(wrap(f.bind('b', 1, 2), 3), 'ignored', [3, 4]); });
tryit(function () { return Reflect.apply(wrap(call, 4), wrap(f, 2), ['T', 5, 6]); });
tryit(function () { return Reflect.apply(wrap(apply, 4), wrap(f.bind('B'), 2), ['T', [7, 8]]); });
tryit(function () { return wrap(call.bind(f.bind('x', 'y')), 3)('this', 'z'); });
tryit(function () { return wrap(apply.bind(f, 'A'), 3)([1, 2, 3]); });
tryit(function () { var c = f; for (var i = 0; i < 6; i++) c = call.bind(c); return wrap(c, 3)('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'); });
tryit(function () { var h1 = function () { return 'h1:' + (this === f) + ':' + arguments.length; }; h1.apply = call; return wrap(new Proxy(f, h1), 2)(1, 2); });
tryit(function () { var h2 = function () { return 'h2:' + (this === f) + ':' + arguments.length; }.bind(null, 'pre'); h2.apply = call; return wrap(new Proxy(f, h2), 2)(1, 2); });
tryit(function () { var h3 = function (a, b) { return 'h3:' + (this === f) + ':' + arguments.length; }; h3.apply = apply; return wrap(new Proxy(f, h3), 2)(1, 2); });
tryit(function () { var h4 = function () { return 'h4:' + arguments.length; }.bind(null, 1, 2); h4.apply = h4; return wrap(new Proxy(f, h4), 2)(1, 2); });
tryit(function () { return wrap(new Proxy(wrap(f, 2), { apply: Reflect.apply.bind(null) }), 2)(9, 8); });
tryit(function () { return wrap(new Proxy(wrap(f, 2), { apply: wrap(function (t, th, a) { return 'pt:' + Reflect.apply(t, th, a); }, 5) }), 2)(4); });
tryit(function () { return wrap(new Proxy(wrap(f, 2), { apply: wrap(function (t, th, a) { return 'bpt:' + Reflect.apply(t, th, a); }.bind(null), 5) }), 2).call('C', 4); });
tryit(function () { return [3, 1, 2].sort(wrap(function (a, b) { return a - b; }.bind(null), 4)).join(); });
tryit(function () { return wrap(new Proxy(f, { apply: wrap(call, 3) }), 2)(1); });
tryit(function () { return wrap(new Proxy(f, { apply: wrap(apply, 3) }), 2)(1); });
tryit(function () { return wrap(new Proxy(f, { apply: wrap(Reflect.apply, 3) }), 2).apply('Q', [1, 2]); });
tryit(function () { return call.apply(wrap(call, 2), [wrap(apply, 2), wrap(f, 2), 'S', [5, 6]]); });
r.join(' ; ')
// ---
// [[Call]] through layers with long argument lists (scratch reservation sizes) and bound
// prefixes below the proxies.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function count() { return arguments.length + ':' + arguments[0] + ':' + arguments[arguments.length - 1]; }
var g = count;
for (var i = 0; i < 30; i++) g = g.bind(null, i);
g = wrap(g, 40);
var big = []; for (var i = 0; i < 3000; i++) big.push(i);
var t = new Proxy(g, { apply: function (tt, th, a) { return 'trap:' + a.length + ':' + Reflect.apply(tt, th, a); } });
[g(), g.apply(null, big), Reflect.apply(g, null, big), Function.prototype.apply.call(g, null, big),
 Function.prototype.call.apply(g, big), t.apply(null, big), wrap(t, 5).call(null, 1, 2, 3)].join(' ; ')
// ---
// [[Call]] at the ceiling and one past it where the bottom is a bound chain (the fold's
// reservation runs at full depth).
function count() { return arguments.length; }
var g = count;
for (var i = 0; i < 50; i++) g = g.bind(null, i);
for (var i = 0; i < 2016; i++) g = new Proxy(g, {});
var r = [g(1)];
g = new Proxy(g, {});
r.push(g(1));
r.join()
// ---
// [[Call]] through call trampolines at full depth.
function count() { return arguments.length; }
var g = count;
for (var i = 0; i < 2015; i++) g = new Proxy(g, {});
var r = [Function.prototype.call.call(g, null, 1, 2), Reflect.apply(g, null, [1])];
var c = Function.prototype.call.bind(g);
r.push(c(null, 1, 2, 3));
r.join()
// ---
// [[Construct]] through layers: newTarget proxies, natives under proxies, a bound target under
// proxies, construct traps that are proxies and bound.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
function F(a) { this.a = a; log.push(typeof new.target, new.target === NT); }
function NT() {}
NT.prototype = { kind: 'nt' };
var r = [];
function tryit(fn) { try { r.push(fn()); } catch (e) { r.push(e.name + ':' + e.message); } }
tryit(function () { var o = Reflect.construct(wrap(F, 5), [1], wrap(NT, 3)); return [o.a, Object.getPrototypeOf(o) === NT.prototype, o.kind].join(); });
tryit(function () { return new (wrap(Array, 4))(3).length; });
tryit(function () { return new (wrap(Map, 4))([[1, 2]]).get(1); });
tryit(function () { return Reflect.construct(wrap(Array, 3), [2], wrap(NT, 2)) instanceof Array; });
tryit(function () { return Reflect.construct(wrap(Date, 3), [0], wrap(NT, 2)).kind; });
tryit(function () { return new (wrap(F.bind(null, 9), 3))().a; });
tryit(function () { var pt = wrap(new Proxy(wrap(F, 2), { construct: wrap(function (t, args, nt) { return Reflect.construct(t, args, nt); }, 4) }), 3); return new pt(5).a; });
tryit(function () { var bt = wrap(new Proxy(wrap(F, 2), { construct: function (t, args, nt) { return Reflect.construct(t, args, nt); }.bind(null) }), 3); return new bt(6).a; });
tryit(function () { var nt = wrap(new Proxy(NT, { get: function (t, k, rr) { log.push('nt.get:' + String(k)); return Reflect.get(t, k, rr); } }), 2); return Reflect.construct(wrap(F, 3), [4], nt).kind; });
tryit(function () { var pc = wrap(new Proxy(F, { construct: Reflect.construct }), 3); return new pc(8).a; });
tryit(function () { return new (wrap(function () { return { own: 1 }; }, 6))().own; });
tryit(function () { return new (wrap(class K { constructor() { this.k = new.target === undefined; } }, 6))().k; });
tryit(function () { return new (wrap(Math.max, 2))(); });
tryit(function () { return new (wrap({ m() {} }.m, 2))(); });
tryit(function () { return Reflect.construct(wrap(F, 2), [], wrap(Math.max, 2)); });
tryit(function () { return Reflect.construct(wrap(F, 2), [], {}); });
r.push(log.join('/'));
r.join(' ; ')
// ---
// [[Construct]] where the trapped layer sits at full depth.
function F() { this.v = 1; }
var p = new Proxy(F, { construct: function (t, a, nt) { return { v: nt === p ? 'top' : 'other' }; } });
for (var i = 0; i < 2014; i++) p = new Proxy(p, {});
var r = [new p().v];
r.join()
// ---
// The depth of the target of a call trampoline reached through proxies: heavy recursion inside.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
Function.prototype.call.call(wrap(r.bind(null), 33), null)
// ---
// The depth of a getter at the terminal of a get walk, and of a setter at the terminal of a set
// walk.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var o = wrap(Object.defineProperty({}, 'g', { get: r }), 27);
o.g
// ---
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var o = wrap(Object.defineProperty({}, 's', { set: r }), 31);
o.s = 1
// ---
// The depth of a getter reached through ordinary levels after a proxy chain.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var o = Object.create(wrap(Object.create(Object.create(wrap(Object.defineProperty({}, 'g', { get: r }), 11))), 13));
o.g
// ---
// The depth of a has trap behind ordinary levels after a forwarded proxy chain (the second leg).
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); }
var o = Object.create(wrap(Object.create(Object.create(wrap(new Proxy({}, { has: r }), 7))), 9));
'x' in o
// ---
// with over a chain whose has trap is far below: frames and depth.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var levels = 0;
function r() { levels++; [0].forEach(r); return false; }
var o = Object.create(wrap(Object.create(Object.create(wrap(new Proxy({}, { has: r }), 7))), 9));
with (o) { levels }
// ---
// A handler that is itself a proxy whose get trap re-enters the outer proxy (bounded).
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var budget = 30, log = [];
var outer;
var hp = wrap(new Proxy({}, { get: function (t, k) { log.push(String(k)); if (budget-- > 0) { return outer.x === undefined ? undefined : undefined; } return undefined; } }), 3);
outer = wrap(new Proxy(wrap({ x: 1 }, 4), hp), 5);
[outer.x, log.length, log.slice(0, 3).join('/')].join()
// ---
// Unbounded re-entry through a handler proxy: the budget halts it, at the same depth and meter.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var outer;
var hp = wrap(new Proxy({}, { get: function (t, k) { return outer[k]; } }), 3);
outer = wrap(new Proxy(wrap({ x: 1 }, 4), hp), 5);
outer.x
// ---
// [[Set]] with a distinct receiver through layers: the terminal defines on a receiver that is
// itself a proxy chain with a defineProperty trap; typed-array terminals with foreign receivers.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
var recv = wrap(new Proxy({}, { defineProperty: function (t, k, d) { log.push('def:' + String(k)); return Reflect.defineProperty(t, k, d); },
  getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); } }), 4);
var p = wrap({ a: 1 }, 6);
var r = [Reflect.set(p, 'a', 2, recv), Reflect.set(p, 'b', 3, recv), Reflect.set(wrap(new Uint8Array(2), 3), 1, 7, recv),
  Reflect.set(wrap(new Uint8Array(2), 3), 5, 7, recv), Reflect.set(wrap(new Uint8Array(2), 3), 0, 9, {})];
var ta = new Uint8Array(2);
r.push(Reflect.set(wrap(ta, 3), 1, 7, wrap(ta, 2)), ta[1]);
r.push(log.join('/'));
r.join()
// ---
// [[Get]] with getters at the terminal reading `this` through the outer chain (nested walks), and
// symbols, toPrimitive, valueOf, hasInstance through layers.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var base = { y: 2, get g() { return this.y + (this === p ? 100 : 0); } };
var p = wrap(base, 9);
var prim = wrap({ valueOf: function () { return 40; }, toString: function () { return 'ts'; } }, 7);
var tp = wrap({ [Symbol.toPrimitive]: wrap(function (h) { return h; }, 3) }, 5);
function F() {}
var HF = wrap(F, 4);
var hi = wrap({ [Symbol.hasInstance]: wrap(function (v) { return v === 1; }, 3) }, 4);
[p.g, prim + 2, '' + prim, `${prim}`, tp + '', +wrap({ valueOf: function () { return 3; } }, 6), new F() instanceof HF, 1 instanceof hi, 2 instanceof hi,
 wrap([1, 2], 3)[Symbol.iterator] === Array.prototype[Symbol.iterator]].join()
// ---
// Object.assign, JSON.stringify, entries, for-in, spread and rest over proxy chains with
// ordinary prototypes that are proxies.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var proto = wrap({ inherited: 1 }, 3);
var o = Object.create(proto); o.own = 2; o[5] = 'five';
var p = wrap(o, 6);
var keys = []; for (var k in p) keys.push(k);
var { own, ...rest } = p;
[JSON.stringify(Object.assign({}, p)), JSON.stringify(p), JSON.stringify(Object.entries(p)), keys.join('/'),
 JSON.stringify({ ...p }), JSON.stringify(rest), own, Array.isArray(wrap([], 9)), Object.getOwnPropertyNames(p).join('/')].join(' ; ')
// ---
// Array generics over proxied arrays and array-likes (HasProperty, Get, Set, Delete with index
// keys, interned and not), and over typed arrays.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var a = wrap([5, , 7, 8], 5);
var al = wrap({ length: 4, 0: 'a', 2: 'c', 3: 'd' }, 5);
var r = [];
r.push(Array.prototype.map.call(a, function (x) { return x * 2; }).join(':'));
r.push(Array.prototype.filter.call(al, function () { return true; }).join(':'));
r.push(Array.prototype.indexOf.call(al, 'c'), Array.prototype.includes.call(a, undefined));
r.push(Array.prototype.reverse.call(wrap([1, 2, 3, , 5], 4)).join(':'));
var s = wrap({ length: 3, 0: 3, 1: 1, 2: 2 }, 4);
Array.prototype.sort.call(s); r.push(s[0], s[1], s[2]);
var big = wrap({ length: 1023456790 }, 3);
try { r.push(Array.prototype.lastIndexOf.call(wrap({ length: 3, 2: 'z' }, 3), 'z')); } catch (e) { r.push(e.name); }
r.push(Array.prototype.at.call(big, -1));
r.push(Array.prototype.slice.call(wrap(new Int8Array([1, 2, 3]), 4), 1).join(':'));
var q = wrap([1, 2, 3], 4); q.length = 1; r.push(q.length, JSON.stringify(q));
r.push(Array.prototype.splice.call(wrap([1, 2, 3, 4], 3), 1, 2).join(':'));
r.join()
// ---
// Generators, async functions and classes reached through proxy chains; super property access
// through prototype chains that contain proxies.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var out = [];
var g = wrap(function* (a) { yield a; yield a + 1; }, 30)(5);
out.push(g.next().value, g.next().value);
wrap(async function (a) { await 0; return a * 3; }, 30)(7).then(function (v) { out.push('async:' + v); });
var Base = { hello() { return 'base:' + this.tag; } };
var mid = wrap(Object.create(wrap(Base, 3)), 3);
var obj = { __proto__: mid, tag: 't', hello() { return 'obj>' + super.hello(); } };
out.push(obj.hello());
class C { m() { return 'C.m'; } }
class D extends C { m() { return 'D>' + super.m(); } }
Object.setPrototypeOf(D.prototype, wrap(C.prototype, 5));
out.push(new D().m());
Promise.resolve().then(function () {}).then(function () { out.push('done'); });
out
// ---
// delete in strict mode through layers (TypeError message), and defineProperty with accessors
// and invariants through layers.
'use strict';
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var t = Object.defineProperty({}, 'fixed', { value: 1, configurable: false });
var p = wrap(t, 7);
var r = [];
try { delete p.fixed; r.push('deleted'); } catch (e) { r.push(e.name + ':' + e.message); }
try { delete p[0]; r.push('ok0'); } catch (e) { r.push(e.name + ':' + e.message); }
try { Object.defineProperty(p, 'acc', { get: function () { return 'A'; }, configurable: true }); r.push(p.acc); } catch (e) { r.push(e.name); }
try { Object.defineProperty(p, 'fixed', { value: 2 }); r.push('redefined'); } catch (e) { r.push(e.name + ':' + e.message); }
var lying = wrap(new Proxy(t, { defineProperty: function () { return true; } }), 5);
try { Object.defineProperty(lying, 'nope', { value: 1, configurable: false }); r.push('lied'); } catch (e) { r.push(e.name + ':' + e.message); }
Object.preventExtensions(t);
try { p.newprop = 1; r.push('added'); } catch (e) { r.push(e.name + ':' + e.message); }
try { p[123456781] = 1; r.push('added-index'); } catch (e) { r.push(e.name + ':' + e.message); }
r.join(' ; ')
// ---
// Revocation by a trap at depth of proxies on the current path, and by a getter of the
// current handler.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var r = [];
var inner = Proxy.revocable({ x: 1 }, {});
var mid = Proxy.revocable(wrap(inner.proxy, 3), {});
var h = {};
Object.defineProperty(h, 'get', { get: function () { mid.revoke(); return undefined; } });
var top = wrap(new Proxy(wrap(mid.proxy, 2), h), 3);
try { r.push(top.x); } catch (e) { r.push(e.message); }
var self = Proxy.revocable({ y: 2 }, {});
var h2 = {};
Object.defineProperty(h2, 'get', { get: function () { self.revoke(); return undefined; } });
self = Proxy.revocable({ y: 2 }, h2);
var t2 = wrap(self.proxy, 4);
try { r.push(t2.y); } catch (e) { r.push(e.message); }
try { r.push(t2.y); } catch (e) { r.push(e.message); }
var inner3 = Proxy.revocable(function () { return 'fn'; }, {});
var t3 = wrap(new Proxy(wrap(inner3.proxy, 2), { get apply() { inner3.revoke(); return undefined; } }), 3);
try { r.push(t3()); } catch (e) { r.push(e.message); }
var inner4 = Proxy.revocable(function () { this.v = 1; }, {});
var t4 = wrap(new Proxy(wrap(inner4.proxy, 2), { get construct() { inner4.revoke(); return undefined; } }), 3);
try { r.push(new t4().v); } catch (e) { r.push(e.message); }
var inner5 = Proxy.revocable({}, {});
var t5 = Object.create(Object.create(wrap(new Proxy(Object.create(wrap(inner5.proxy, 2)), { get has() { inner5.revoke(); return undefined; } }), 2)));
try { r.push('q' in t5); } catch (e) { r.push(e.message); }
r.join(' ; ')
