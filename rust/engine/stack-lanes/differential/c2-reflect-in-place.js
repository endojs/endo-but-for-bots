// C2: `RUN` of the intrinsic `Reflect.apply` or `Reflect.construct` whose target is a user
// function over the same buffer enters the target's frame in its own dispatch loop, above
// the `Reflect` call's frame, the frame holding the native's 16 units with the 16 its
// nested `dispatch_at` charged, and its `END` cutting both frames. Every kind of target,
// receiver and argument list, and the result where pending operands expect it.
var r = [];
function show() { return [typeof this, this && this.k, arguments.length, [].slice.call(arguments).join('|')].join(':'); }
var o = { k: 'o' };
r.push(Reflect.apply(show, o, []), Reflect.apply(show, null, [1, 2]), Reflect.apply(show, 5, { length: 2, 0: 'a', 1: 'b' }));
(function () { r.push(Reflect.apply(show, undefined, arguments)); })(7, 8);
var sparse = [1, , 3]; Array.prototype[1] = 'proto';
r.push(Reflect.apply(show, o, sparse)); delete Array.prototype[1];
r.push(Reflect.apply(function () { 'use strict'; return typeof this; }, undefined, []));
var arrow = (x) => [typeof this, x];
r.push(Reflect.apply(arrow, o, [5]).join());
class K { m() { return 1; } }
try { Reflect.apply(K, null, []); } catch (e) { r.push('apply-class:' + e.constructor.name); }
r.push(Reflect.apply(Math.max, null, [1, 5, 3]), Reflect.apply(show.bind(o, 'b'), null, [1]), Reflect.apply(new Proxy(show, {}), o, [2]));
var ra = Reflect.apply; r.push(ra(show, o, [3]));
r.push(Reflect.apply(show, o, [4], 'extra', 'args'));
try { Reflect.apply(show, null); } catch (e) { r.push('no-list:' + e.constructor.name); }
try { Reflect.apply(1, null, []); } catch (e) { r.push('not-callable:' + e.constructor.name); }
try { Reflect.apply(show, null, 'ab'); } catch (e) { r.push('string-list:' + e.constructor.name); }
try { new Reflect.apply(show, null, []); } catch (e) { r.push('new-apply:' + e.constructor.name); }
try { Reflect.apply(show, null, { get length() { throw new Error('length'); } }); } catch (e) { r.push(e.message); }
try { Reflect.apply(show, null, { length: 1, get 0() { throw new Error('elem'); } }); } catch (e) { r.push(e.message); }
r.push([1, Reflect.apply(show, o, [2]), 3].length, 10 + Reflect.apply(function (a) { return a * 2; }, null, [4]) * 3);
r.push(`t${Reflect.apply(function () { return 'x'; }, null, [])}u`);
function id(a, b) { return a + '/' + b; }
r.push(id(Reflect.apply(id, null, [1, 2]), Reflect.apply(id, null, [3, 4])));
r.push(Reflect.apply(show, o, { length: 1, get 0() { return Reflect.apply(id, null, ['g', 'h']); } }));
function tail(n) { return n ? Reflect.apply(tail, null, [n - 1]) : 'tail'; }
r.push(tail(10));
r.join(' ')
// ---
// Generator, async and async-generator targets: each starts and returns its object or
// promise to where the call's result belongs, with operands pending around it.
var r = [];
function* gen(a) { yield a; yield a + 1; }
r.push([0, ...Reflect.apply(gen, null, [5]), 9].join(), 1 + Reflect.apply(gen, null, [2]).next().value);
var it = Reflect.apply(gen, null, [7]); r.push(it.next().value, it.next().value, it.next().done);
function* gthrow() { throw new Error('gen-body'); }
var gt = Reflect.apply(gthrow, null, []);
try { gt.next(); } catch (e) { r.push(e.message); }
async function af(a) { var x = await a; return x * 2; }
async function athrow() { await 0; throw new Error('async-body'); }
var p1 = Reflect.apply(af, null, [21]);
r.push(typeof p1.then, [Reflect.apply(af, null, [1]) instanceof Promise, 'after'].join());
p1.then(function (v) { r.push('af:' + v); });
Reflect.apply(athrow, null, []).catch(function (e) { r.push(e.message); });
async function* ag(a) { yield a; yield await a + 1; }
var ai = Reflect.apply(ag, null, [3]);
ai.next().then(function (v) { r.push('ag:' + v.value); return ai.next(); }).then(function (v) { r.push('ag:' + v.value); });
r.push(Object.prototype.toString.call(ai));
class Sub extends Array {}
r.push(Reflect.construct(Sub, [3]).length);
r
// ---
// Reflect.construct: user, class, derived and returning constructors, the new target,
// native, Proxy and non-constructor targets, and argument lists.
var r = [];
function F(a, b) { this.s = a + b; }
r.push(Reflect.construct(F, [1, 2]).s, Reflect.construct(F, { length: 2, 0: 'x', 1: 'y' }).s);
function NT() { this.nt = new.target === NT ? 'self' : new.target === G ? 'G' : String(new.target); }
function G() {}
r.push(Reflect.construct(NT, []).nt, Reflect.construct(NT, [], G).nt, Object.getPrototypeOf(Reflect.construct(NT, [], G)) === NT.prototype);
class A { constructor(v) { this.v = v; } }
class B extends A { constructor(v) { super(v * 2); this.w = 1; } }
class C extends A { constructor() { return { own: true }; } }
class D extends A { constructor() { 1; } }
r.push(Reflect.construct(A, [3]).v, Reflect.construct(B, [3]).v, Reflect.construct(C, []).own);
try { Reflect.construct(D, []); } catch (e) { r.push('derived:' + e.constructor.name); }
function Prim() { this.a = 1; return 5; }
function Obj() { this.a = 1; return [9]; }
r.push(Reflect.construct(Prim, []).a, Reflect.construct(Obj, [])[0]);
r.push(Reflect.construct(Array, [3]).length, Reflect.construct(Date, [0]).getTime(), Reflect.construct(new Proxy(F, {}), [4, 5]).s);
try { Reflect.construct(() => 1, []); } catch (e) { r.push('arrow:' + e.constructor.name); }
try { Reflect.construct(function* () {}, []); } catch (e) { r.push('gen:' + e.constructor.name); }
try { Reflect.construct(F, [], Math.max); } catch (e) { r.push('nt:' + e.constructor.name); }
try { Reflect.construct(F, 1); } catch (e) { r.push('list:' + e.constructor.name); }
try { Reflect.construct(function () { throw new Error('ctor'); }, []); } catch (e) { r.push(e.message); }
r.push([0, Reflect.construct(F, [1, 1]).s, 9].join(), Reflect.construct(F, [1, 2], F, 'extra').s);
r.join()
// ---
// Nests at their ceilings and one past them: the refusal happens at the same level.
function f(n) { if (n > 0) Reflect.apply(f, null, [n - 1]); return 'bottom'; }
var r = [];
try { r.push(f(40)); } catch (e) { r.push('caught'); }
r.push(f(63));
r.join()
// ---
function f(n) { if (n > 0) Reflect.apply(f, null, [n - 1]); return 'bottom'; }
try { f(64); } catch (e) { 'caught'; }
// ---
function C(n) { if (n > 0) Reflect.construct(C, [n - 1]); this.n = n; }
Reflect.construct(C, [62]).n
// ---
function C(n) { if (n > 0) Reflect.construct(C, [n - 1]); this.n = n; }
Reflect.construct(C, [63]).n
// ---
// Mixed with bound and Proxy levels.
function f(n) { return n > 0 ? (n % 3 === 0 ? Reflect.apply(f, null, [n - 1]) : n % 3 === 1 ? f.bind(null, n - 1)() : new Proxy(f, {})(n - 1)) : 'bottom'; }
var r = [f(80)];
r.push(f(85));
r.join()
// ---
// Throws from inside Reflect levels: caught by the callee, by an intermediate level, and
// by the outermost caller; then a nest that needs most of the budget, which completes
// only if every level gave its units back.
var log = [];
function f(n, at) { if (n === at) throw new Error('at' + n); return n > 0 ? Reflect.apply(f, null, [n - 1, at]) : 'ok'; }
function h(n, at, catchAt) { if (n === catchAt) { try { return f(n, at); } catch (e) { return 'caught:' + e.message; } } return n > 0 ? Reflect.apply(h, null, [n - 1, at, catchAt]) : f(0, at); }
log.push(h(40, 10, 30), h(40, 0, 39));
try { f(50, 3); } catch (e) { log.push(e.message); }
function K(n, at) { if (n === at) throw new Error('k' + n); if (n > 0) Reflect.construct(K, [n - 1, at]); }
try { Reflect.construct(K, [50, 7]); } catch (e) { log.push(e.message); }
function deep(n) { return n > 0 ? Reflect.apply(deep, null, [n - 1]) : n; }
log.push(deep(63));
log.join()
// ---
// flags: --eval-compiler
// Throws escaping in-place Reflect levels through every native that catches a guest throw:
// a Promise executor, `eval`, a generator body, an async function body, a JSON replacer
// and reviver, a sort comparator and an Array callback; then the budget probe.
var log = [];
function thrower(n) { return n > 0 ? Reflect.apply(thrower, null, [n - 1]) : (function () { throw new TypeError('deep'); })(); }
new Promise(function () { thrower(30); }).catch(function (e) { log.push('promise:' + e.message); });
try { eval('thrower(30)'); } catch (e) { log.push('eval:' + e.message); }
try { eval('(function () { return thrower(30); })')(); } catch (e) { log.push('eval-fn:' + e.message); }
function* gn() { yield 1; thrower(30); }
var it = gn(); it.next();
try { it.next(); } catch (e) { log.push('gen:' + e.message); }
async function an() { thrower(30); }
an().catch(function (e) { log.push('async:' + e.message); });
try { JSON.stringify({ a: 1 }, function (k, v) { if (k === 'a') thrower(30); return v; }); } catch (e) { log.push('replacer:' + e.message); }
try { JSON.parse('{"a":1}', function (k, v) { if (k === 'a') thrower(30); return v; }); } catch (e) { log.push('reviver:' + e.message); }
try { [3, 1, 2].sort(function () { thrower(30); }); } catch (e) { log.push('sort:' + e.message); }
try { [1].forEach(function () { thrower(30); }); } catch (e) { log.push('forEach:' + e.message); }
function deep(n) { return n > 0 ? Reflect.apply(deep, null, [n - 1]) : n; }
log.push(deep(63));
Promise.resolve().then(function () { log.push(deep(63)); });
log
// ---
// A value-stack overflow under Reflect levels halts where it did.
function deep() { return deep(); }
function f(n) { return n > 0 ? Reflect.apply(f, null, [n - 1]) : deep(); }
f(40)
// ---
function deep() { return deep(); }
function C(n) { if (n > 0) Reflect.construct(C, [n - 1]); else deep(); }
Reflect.construct(C, [40])
// ---
// Value-stack overflows in recursions through Reflect calls that pass k arguments a call
// and leave j extra arguments in the Reflect call's frame: each reaches the budget at its
// own point of a call.
var a = []; for (var i = 0; i < 55; i++) a.push(i);
function f() { return Reflect.apply(f, null, a); }
f()
// ---
var a = []; for (var i = 0; i < 61; i++) a.push(i);
function f() { return Reflect.apply(f, null, a); }
f()
// ---
var a = []; for (var i = 0; i < 50; i++) a.push(i);
function f() { return Reflect.apply(f, null, a, 1, 2, 3, 4, 5, 6, 7); }
f()
// ---
var a = []; for (var i = 0; i < 999; i++) a.push(i);
function f() { return Reflect.apply(f, null, a, 1); }
f()
// ---
var a = []; for (var i = 0; i < 2000; i++) a.push(i);
function C() { Reflect.construct(C, a); }
Reflect.construct(C, a)
// ---
var a = []; for (var i = 0; i < 55; i++) a.push(i);
function C() { Reflect.construct(C, a, C, 1, 2); }
Reflect.construct(C, a)
// ---
var a = []; for (var i = 0; i < 61; i++) a.push(i);
function C() { Reflect.construct(C, a, C, 1, 2); }
Reflect.construct(C, a)
// ---
// The render of a thrown deeply nested array is the same at any Reflect depth: the halt
// releases every level's units before the value is rendered.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { if (n === 0) throw nest(2040); return Reflect.apply(f, null, [n - 1]); }
f(50)
// ---
// And of a completion value built after a Reflect nest returned.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { return n > 0 ? Reflect.apply(f, null, [n - 1]) : 0; }
function C(n) { if (n > 0) Reflect.construct(C, [n - 1]); }
f(60); Reflect.construct(C, [60]); nest(2040)
// ---
// A stack trace taken in a callee entered through Reflect names the same frames.
function inner() { return new Error('t').stack; }
function mid() { return Reflect.apply(inner, null, []); }
function Ctor() { this.s = Reflect.apply(mid, null, []); }
Reflect.construct(Ctor, []).s
// ---
// flags: --eval-compiler
// Targets in another code segment (defined by `eval` or `Function`) still run in a nested
// loop; a nest through them, and a nest of in-place levels inside one.
var r = [];
var ev = eval('(function (a) { return "eval:" + a; })');
r.push(Reflect.apply(ev, null, ['x']), Reflect.apply(Function('a', 'return "fn:" + a'), null, ['y']));
r.push(Reflect.construct(eval('(function (a) { this.a = a; })'), ['z']).a);
var ef = eval('(function ef(n) { return n > 0 ? Reflect.apply(ef, null, [n - 1]) + 1 : 0; })');
r.push(ef(50));
function local(n) { return n > 0 ? Reflect.apply(local, null, [n - 1]) + 1 : 0; }
r.push(eval('local(50)'), Function('return local(50)')());
r.join()
// ---
// Throws from inside an explicit-stack walk (JSON.parse, JSON.stringify's toJSON, a
// reviver, `flat` over a throwing getter, a flatMap callback) caught below the Reflect
// frame that called the walk, 200 times: each pop of that frame inside the walk released
// its units, and the walk's restore must not charge them again.
var r = [];
function p(x) { return JSON.parse(x); }
for (var i = 0; i < 200; i++) { try { Reflect.apply(p, null, ['{']); } catch (e) {} }
var bad = { toJSON: function () { throw 1; } };
function S(x) { this.s = JSON.stringify(x); }
for (var i = 0; i < 200; i++) { try { Reflect.construct(S, [bad]); } catch (e) {} }
function v(x) { return JSON.parse(x, function (k, w) { if (k === 'a') throw 2; return w; }); }
for (var i = 0; i < 200; i++) { try { Reflect.apply(v, null, ['{"a":[1]}']); } catch (e) {} }
var hole = [1]; Object.defineProperty(hole, 0, { get: function () { throw 3; } });
function fl(x) { return [x].flat(); }
for (var i = 0; i < 200; i++) { try { Reflect.apply(fl, null, [hole]); } catch (e) {} }
function fm() { return [[1]].flatMap(function () { throw 4; }); }
for (var i = 0; i < 200; i++) { try { Reflect.apply(fm, null, []); } catch (e) {} }
function deep(n) { return n > 0 ? Reflect.apply(deep, null, [n - 1]) : 'deep'; }
r.push(deep(63));
r.join()
// ---
// The same, then a completion value that needs nearly the whole render budget.
function f(n) {
  if (n > 0) return Reflect.apply(f, null, [n - 1]);
  return [[1]].flatMap(function (x) { throw 1; });
}
try { f(50); } catch (e) {}
var a = [1]; for (var i = 0; i < 2040; i++) a = [a];
a
// ---
// Calls that do not reach `RUN` (through `.call`, `.apply`, a callback, a bound copy or a
// Proxy of `Reflect.apply`) keep the native's path, nested among in-place ones.
var r = [];
function g(n) { return n > 0 ? h(n - 1) + 1 : 0; }
function h(n) {
  switch (n % 5) {
    case 0: return Reflect.apply.call(null, g, null, [n]);
    case 1: return Reflect.apply.apply(null, [g, null, [n]]);
    case 2: return [n].map(function (m) { return Reflect.apply(g, null, [m]); })[0];
    case 3: return Reflect.apply.bind(null, g, null)([n]);
    default: return new Proxy(Reflect.apply, {})(g, null, [n]);
  }
}
r.push(g(30));
r.push([[1, 2]].map(Reflect.apply.bind(null, Math.max, null))[0]);
r.join()
// ---
// The new target `Reflect.construct` names: the instance's prototype read from it (an
// accessor, an inherited property, a non-object falling back to the realm's), the
// `new.target` the body sees, in arrows and `super()` chains, and Proxy, bound, class
// and native new targets; each through an in-place target and a nest of them.
var r = [];
function NT() { this.nt = new.target === NT ? 'self' : new.target && new.target.name; this.arrow = (() => new.target && new.target.name)(); }
function G() {}
G.prototype.tag = 'G';
r.push(JSON.stringify(Reflect.construct(NT, [], G)), Reflect.construct(NT, [], G).tag, Reflect.construct(NT, []).nt);
var getterNT = G.bind(null);
Object.setPrototypeOf(getterNT, { get prototype() { r.push('proto-get'); return { tag: 'H' }; } });
try { r.push(Reflect.construct(NT, [], getterNT).tag); } catch (e) { r.push('getter-nt:' + e.constructor.name); }
function I() {} I.prototype = 5;
r.push(Object.getPrototypeOf(Reflect.construct(NT, [], I)) === Object.prototype);
var pnt = new Proxy(G, { get: function (t, k) { r.push('nt-get:' + String(k)); return t[k]; } });
r.push(Reflect.construct(NT, [], pnt).tag);
r.push(Reflect.construct(NT, [], G.bind(null)).nt);
class A { constructor() { this.a = new.target.name; } }
class B extends A { constructor() { super(); this.b = new.target.name; } }
class C {}
r.push(JSON.stringify(Reflect.construct(B, [], C)), Reflect.construct(B, [], C) instanceof C);
r.push(Reflect.construct(NT, [], Array).nt, Array.isArray(Reflect.construct(NT, [], Array)));
function Nest(n, nt) { this.n = n; this.inner = n > 0 ? Reflect.construct(Nest, [n - 1, nt], nt).inner + 1 : (new.target === nt ? 0 : -1000); }
r.push(Reflect.construct(Nest, [30, G], G).inner, Reflect.construct(Nest, [30, Nest]).inner);
r.join(' ')
