// B1: [[Get]] through trap-absent layers, with a logging `get` trap in the middle, a getter
// at the bottom whose receiver is the outermost proxy, and a missing property.
var log = [];
var base = { get g() { log.push(this === p); return 7; }, v: 1 };
var p = base;
for (var i = 0; i < 40; i++) {
  p = new Proxy(p, i === 20 ? { get: function (t, k, r) { log.push('get:' + String(k)); return Reflect.get(t, k, r); } } : {});
}
[p.v, p.g, p.missing, p[Symbol.iterator], log.join('/')].join()
// ---
// [[Get]] with index keys through layers: an array, a typed array, a string wrapper, an
// ordinary object's index store, and a proxy in a prototype chain.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var a = wrap([10, 20, 30], 30), t = wrap(new Uint8Array([1, 2, 3]), 30), s = wrap(new String('xyz'), 30);
var o = wrap({ 0: 'zero', 5: 'five' }, 30);
var child = Object.create(wrap([7, 8], 10));
[a[1], a[7], t[2], t[9], s[0], s[3], o[5], o[4], child[1], child[2], a.length, s.length].join()
// ---
// The Array Iterator's residual metering through forwarded layers, with and without a
// get trap above them.
var inner = new Proxy(new Proxy({ length: 3, 0: 7, 1: 8, 2: 9 }, {}), { get: function (t, k, r) { return Reflect.get(t, k, r); } });
var r = [];
for (var v of Array.prototype.values.call(inner)) r.push(v);
var plain = new Proxy(new Proxy(new Proxy([1, 2, 3], {}), {}), {});
for (var v of plain) r.push(v);
r.push([...new Proxy(new Proxy(new String('ab'), {}), {})].join(':'));
r.push(Array.from(new Proxy(new Proxy({ length: 2, 0: 'p', 1: 'q' }, {}), {})).join(':'));
r.join()
// ---
// [[Set]] through layers: a setter at the bottom sees the outer receiver, a `set` trap in the
// middle, a non-writable property, and the invariant violation of a trap that returns true.
var log = [];
var base = { set s(v) { log.push(this === p, v); }, w: 1 };
Object.defineProperty(base, 'ro', { value: 1, writable: false, configurable: false });
var p = base;
for (var i = 0; i < 25; i++) {
  p = new Proxy(p, i === 12 ? { set: function (t, k, v, r) { log.push('set:' + String(k)); return Reflect.set(t, k, v, r); } } : {});
}
p.s = 5; p.w = 2; p.fresh = 3;
var r = [log.join('/'), base.w, Reflect.set(p, 'ro', 2)];
var lying = new Proxy(new Proxy(base, {}), { set: function () { return true; } });
try { 'use strict'; lying.ro = 9; r.push('no throw'); } catch (e) { r.push(e.name); }
try { Reflect.set(lying, 'ro', 9); r.push('reflect ok'); } catch (e) { r.push(e.name); }
r.join()
// ---
// [[HasProperty]]: `in` through layers and through ordinary prototype levels before a proxy,
// whose frame count is metered; a `has` trap below some layers; index keys too.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var deep = { z: 1 };
var chain = wrap(deep, 15);
var o1 = Object.create(chain), o2 = Object.create(o1), o3 = Object.create(o2);
var log = [];
var trapped = wrap(new Proxy({ q: 1 }, { has: function (t, k) { log.push(String(k)); return k in t; } }), 9);
var r = ['z' in o3, 'nope' in o3, 'q' in trapped, 'x' in trapped, 0 in wrap([5], 12), 3 in wrap([5], 12),
  1 in Object.create(wrap(new Uint8Array(2), 4)), 'length' in wrap('str' instanceof String ? 'str' : new String('str'), 3)];
r.push(log.join('/'));
r.join()
// ---
// [[HasProperty]] invariant: a trap that hides a non-configurable property, below layers.
var target = {};
Object.defineProperty(target, 'k', { value: 1, configurable: false });
var p = new Proxy(target, { has: function () { return false; } });
for (var i = 0; i < 10; i++) p = new Proxy(p, {});
var r = [];
try { r.push('k' in p); } catch (e) { r.push(e.name); }
Object.preventExtensions(target);
var q = new Proxy(target, { has: function (t, k) { return k !== 'k'; } });
for (var i = 0; i < 10; i++) q = new Proxy(q, {});
try { r.push('k' in q); } catch (e) { r.push(e.name); }
r.join()
// ---
// [[GetOwnProperty]], [[DefineOwnProperty]] and their invariants through layers, by name and
// by index.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
var base = { a: 1 };
var p = wrap(new Proxy(wrap(base, 5), {
  getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
  defineProperty: function (t, k, d) { log.push('def:' + String(k)); return Reflect.defineProperty(t, k, d); },
}), 5);
var r = [JSON.stringify(Object.getOwnPropertyDescriptor(p, 'a')), Object.getOwnPropertyDescriptor(p, 'b')];
Object.defineProperty(p, 'c', { value: 3, enumerable: true, configurable: true, writable: true });
r.push(base.c, Object.prototype.hasOwnProperty.call(p, 'a'));
var arr = wrap([1, 2], 20);
r.push(JSON.stringify(Object.getOwnPropertyDescriptor(arr, 1)), Object.getOwnPropertyDescriptor(arr, 7));
Object.defineProperty(arr, 4, { value: 9, configurable: true, enumerable: true, writable: true });
r.push(arr.length, JSON.stringify(Object.getOwnPropertyDescriptor(wrap(new Uint8Array([4, 5]), 8), 1)));
var frozen = Object.freeze({ f: 1 });
var liar = wrap(new Proxy(frozen, { getOwnPropertyDescriptor: function () { return undefined; } }), 6);
try { Object.getOwnPropertyDescriptor(liar, 'f'); r.push('no throw'); } catch (e) { r.push(e.name); }
var bad = wrap(new Proxy({}, { defineProperty: function () { return true; } }), 6);
try { Object.defineProperty(bad, 'x', { value: 1, configurable: false }); r.push('no throw'); } catch (e) { r.push(e.name); }
r.push(log.join('/'));
r.join()
// ---
// [[Delete]] by name and index through layers, with a trap and its invariant.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var base = { a: 1, b: 2, 3: 'three' };
Object.defineProperty(base, 'fixed', { value: 1, configurable: false });
var p = wrap(base, 30);
var r = [delete p.a, 'a' in base, delete p.fixed, delete p[3], 3 in base, delete p.nope];
var arr = [1, 2, 3];
var pa = wrap(arr, 30);
r.push(delete pa[1], arr.length, 1 in arr, delete wrap(new Uint8Array(2), 4)[0], delete wrap(new String('ab'), 4)[0]);
var log = [];
var trapped = wrap(new Proxy(base, { deleteProperty: function (t, k) { log.push(String(k)); return true; } }), 7);
try { delete trapped.fixed; r.push('no throw'); } catch (e) { r.push(e.name); }
r.push(delete trapped.b, 'b' in base, log.join('/'));
r.join()
// ---
// [[OwnPropertyKeys]] through layers: keys, spread, for-in, an ownKeys trap and its invariants.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var sym = Symbol('s');
var base = { b: 1, a: 2, 1: 'one', 0: 'zero' };
base[sym] = 3;
var p = wrap(base, 35);
var r = [Object.keys(p).join(':'), Reflect.ownKeys(p).length, JSON.stringify({ ...p }), Object.getOwnPropertyNames(wrap([1, 2], 9)).join(':')];
var forin = [];
for (var k in wrap(Object.create(p), 3)) forin.push(k);
r.push(forin.join(':'));
var trapped = wrap(new Proxy(base, { ownKeys: function (t) { return ['a', 'b', '0', '1', sym, 'extra']; } }), 5);
r.push(Reflect.ownKeys(trapped).length);
var sealed = Object.seal({ s: 1 });
var liar = wrap(new Proxy(sealed, { ownKeys: function () { return []; } }), 5);
try { Reflect.ownKeys(liar); r.push('no throw'); } catch (e) { r.push(e.name); }
var dup = wrap(new Proxy({}, { ownKeys: function () { return ['x', 'x']; } }), 5);
try { Reflect.ownKeys(dup); r.push('no throw'); } catch (e) { r.push(e.name); }
r.join()
// ---
// [[GetPrototypeOf]] and [[SetPrototypeOf]] through layers: instanceof, isPrototypeOf, a trap
// in the middle, the non-extensible invariant, and the forwarding metering of each hop.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function C() {}
var obj = new C();
var p = wrap(obj, 25);
var log = [];
var mid = wrap(new Proxy(wrap(obj, 4), { getPrototypeOf: function (t) { log.push('gpo'); return Reflect.getPrototypeOf(t); } }), 4);
var r = [p instanceof C, C.prototype.isPrototypeOf(p), Object.getPrototypeOf(p) === C.prototype, mid instanceof C, Object.getPrototypeOf(mid) === C.prototype];
var proto2 = {};
r.push(Reflect.setPrototypeOf(wrap(obj, 25), proto2), Object.getPrototypeOf(obj) === proto2);
var ne = Object.preventExtensions({});
var lying = wrap(new Proxy(ne, { getPrototypeOf: function () { return Array.prototype; } }), 5);
try { Object.getPrototypeOf(lying); r.push('no throw'); } catch (e) { r.push(e.name); }
r.push(Reflect.setPrototypeOf(wrap(ne, 5), {}), log.join('/'));
var notCallable = wrap(new Proxy({}, { getPrototypeOf: 7 }), 3);
try { Object.getPrototypeOf(notCallable); r.push('no throw'); } catch (e) { r.push(e.name); }
r.join()
// ---
// [[IsExtensible]] and [[PreventExtensions]] through layers, with traps and their invariants.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var base = {};
var p = wrap(base, 30);
var r = [Object.isExtensible(p), Reflect.preventExtensions(p), Object.isExtensible(base), Object.isExtensible(p)];
var liar = wrap(new Proxy({}, { isExtensible: function () { return false; } }), 5);
try { Object.isExtensible(liar); r.push('no throw'); } catch (e) { r.push(e.name); }
var liar2 = wrap(new Proxy({}, { preventExtensions: function () { return true; } }), 5);
try { Object.preventExtensions(liar2); r.push('no throw'); } catch (e) { r.push(e.name); }
r.push(Object.isFrozen(wrap(Object.freeze({ a: 1 }), 5)), Object.isSealed(wrap({ a: 1 }, 5)));
r.join()
// ---
// Revocation mid-chain, for each internal method.
function chain(t) {
  var inner = Proxy.revocable(t, {});
  var p = inner.proxy;
  for (var i = 0; i < 10; i++) p = new Proxy(p, {});
  inner.revoke();
  return p;
}
var ops = [
  function (p) { return p.x; }, function (p) { p.x = 1; }, function (p) { return 'x' in p; },
  function (p) { return delete p.x; }, function (p) { return Object.keys(p); },
  function (p) { return Object.getOwnPropertyDescriptor(p, 'x'); }, function (p) { Object.defineProperty(p, 'x', { value: 1 }); },
  function (p) { return Object.getPrototypeOf(p); }, function (p) { return Object.setPrototypeOf(p, null); },
  function (p) { return Object.isExtensible(p); }, function (p) { return Object.preventExtensions(p); },
  function (p) { return p[0]; }, function (p) { return 0 in p; }, function (p) { return delete p[0]; },
  function (p) { return p(); }, function (p) { return new p(); },
];
var r = [];
ops.forEach(function (op) {
  try { op(chain(function () {})); r.push('ok'); } catch (e) { r.push(e.name); }
});
r.join()
// ---
// Handler traps read through getters, which run guest code at every layer, in order.
var log = [];
function handler(i) {
  return Object.create(null, { get: { get: function () { log.push(i); return undefined; } } });
}
var p = { v: 1 };
for (var i = 0; i < 12; i++) p = new Proxy(p, handler(i));
[p.v, log.join('/')].join()
// ---
// [[Call]] through layers: the receiver and arguments reach the target, an apply trap in the
// middle, bound targets below proxies (their scratch reservation), and the call/apply
// trampolines.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(a, b, c) { return [this === undefined ? 'u' : typeof this, a, b, c].join('.'); }
var r = [wrap(f, 30)(1, 2, 3), wrap(f.bind('t', 'x'), 20)(1, 2), wrap(f.bind(null, 9), 5)(8),
  wrap(f.call, 6).call(f, {}, 4, 5), wrap(f.apply, 4).call(f, 0, [6, 7]), Reflect.apply(wrap(f, 10), null, [1])];
var log = [];
var trapped = wrap(new Proxy(wrap(f.bind(null, 'b'), 3), { apply: function (t, th, args) { log.push(args.length); return Reflect.apply(t, th, args); } }), 7);
r.push(trapped(1, 2), log.join('/'));
var o = { m: wrap(function () { return this === o; }, 9) };
r.push(o.m(), [1, 2, 3].map(wrap(function (x) { return x * 2; }, 8)).join(':'));
r.join()
// ---
// [[Call]] errors through layers: a non-callable apply trap, a trap that throws, a revoked
// layer under a trap.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f() { return 1; }
var r = [];
try { wrap(new Proxy(f, { apply: 5 }), 5)(); r.push('no throw'); } catch (e) { r.push(e.name); }
try { wrap(new Proxy(f, { apply: function () { throw new SyntaxError('trap'); } }), 5)(); } catch (e) { r.push(e.name + ':' + e.message); }
var rv = Proxy.revocable(f, {});
var top = wrap(new Proxy(rv.proxy, { apply: function (t, th, a) { return Reflect.apply(t, th, a); } }), 3);
rv.revoke();
try { top(); r.push('no throw'); } catch (e) { r.push(e.name); }
r.join()
// ---
// [[Construct]] through layers: a function, newTarget through Reflect.construct, a construct
// trap in the middle.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function F(a) { this.a = a; this.nt = new.target === F; }
var r = [JSON.stringify(new (wrap(F, 30))(1))];
var log = [];
var trapped = wrap(new Proxy(wrap(F, 4), { construct: function (t, args, nt) { log.push(args.length, nt === trapped); return Reflect.construct(t, args, nt); } }), 4);
r.push(JSON.stringify(new trapped(7, 8)), log.join('/'));
function G() { this.g = new.target === G; }
r.push(JSON.stringify(Reflect.construct(wrap(F, 12), [3], G)));
r.join()
// ---
// [[Construct]] errors through layers: a trap returning a primitive, an arrow target.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function F() {}
var r = [];
var prim = wrap(new Proxy(F, { construct: function () { return 1; } }), 3);
try { new prim(); r.push('no throw'); } catch (e) { r.push(e.name); }
try { new (wrap(() => 1, 3))(); r.push('no throw'); } catch (e) { r.push(e.name); }
r.join()
// ---
// ---
// get through 2032 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2032; i++) p = new Proxy(p, {});
p.x
// ---
// get through 2033 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2033; i++) p = new Proxy(p, {});
p.x
// ---
// set through 1015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 1015; i++) p = new Proxy(p, {});
(p.x = 1, 1)
// ---
// set through 1016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 1016; i++) p = new Proxy(p, {});
(p.x = 1, 1)
// ---
// has through 2032 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2032; i++) p = new Proxy(p, {});
'x' in p
// ---
// has through 2033 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2033; i++) p = new Proxy(p, {});
'x' in p
// ---
// delete through 2032 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2032; i++) p = new Proxy(p, {});
delete p.y
// ---
// delete through 2033 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2033; i++) p = new Proxy(p, {});
delete p.y
// ---
// ownKeys through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Object.keys(p).length
// ---
// ownKeys through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Object.keys(p).length
// ---
// gopd through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Object.getOwnPropertyDescriptor(p, 'x') !== undefined
// ---
// gopd through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Object.getOwnPropertyDescriptor(p, 'x') !== undefined
// ---
// define through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
(Object.defineProperty(p, 'z', { value: 1, configurable: true }), 1)
// ---
// define through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
(Object.defineProperty(p, 'z', { value: 1, configurable: true }), 1)
// ---
// getPrototypeOf through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Object.getPrototypeOf(p) === Object.prototype
// ---
// getPrototypeOf through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Object.getPrototypeOf(p) === Object.prototype
// ---
// setPrototypeOf through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Reflect.setPrototypeOf(p, Object.prototype)
// ---
// setPrototypeOf through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Reflect.setPrototypeOf(p, Object.prototype)
// ---
// isExtensible through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Object.isExtensible(p)
// ---
// isExtensible through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Object.isExtensible(p)
// ---
// preventExtensions through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Reflect.preventExtensions(p)
// ---
// preventExtensions through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Reflect.preventExtensions(p)
// ---
// index get through 2031 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2031; i++) p = new Proxy(p, {});
p[0]
// ---
// index get through 2032 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2032; i++) p = new Proxy(p, {});
p[0]
// ---
// index has through 2032 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2032; i++) p = new Proxy(p, {});
0 in p
// ---
// index has through 2033 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2033; i++) p = new Proxy(p, {});
0 in p
// ---
// index delete through 2032 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2032; i++) p = new Proxy(p, {});
delete p[1]
// ---
// index delete through 2033 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2033; i++) p = new Proxy(p, {});
delete p[1]
// ---
// index gopd through 2015 trap-absent layers (the ceiling).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
Object.getOwnPropertyDescriptor(p, 0) !== undefined
// ---
// index gopd through 2016 trap-absent layers (one past it).
var p = { x: 1, 0: 'z' };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
Object.getOwnPropertyDescriptor(p, 0) !== undefined
// ---
// call through 2016 trap-absent layers (the ceiling).
var p = function () { return 'called'; };
for (var i = 0; i < 2016; i++) p = new Proxy(p, {});
p()
// ---
// call through 2017 trap-absent layers (one past it).
var p = function () { return 'called'; };
for (var i = 0; i < 2017; i++) p = new Proxy(p, {});
p()
// ---
// construct through 2014 trap-absent layers (the ceiling).
function F() { this.v = 1; }
var p = F;
for (var i = 0; i < 2014; i++) p = new Proxy(p, {});
new p().v
// ---
// construct through 2015 trap-absent layers (one past it).
function F() { this.v = 1; }
var p = F;
for (var i = 0; i < 2015; i++) p = new Proxy(p, {});
new p().v
