// D2a review: programs the pre-commit review wrote to reach the coder walk's arms beyond
// d2-coder.js; every one gave the same output from the base and the changed probes.
// Private members in chains: value, call, optional, computed after private, update and
// compound through `code_this` with flag 1, brand checks inside binary chains, and a
// private method as a tag.
class P {
  #p = { q: { r: 3 }, f() { return this.q.r; } };
  #n = null;
  #c = 1;
  #m() { return this === undefined ? 'u' : 'm'; }
  static #s = 5;
  t(s) { return s.raw.join(); }
  run(o) {
    var r = [];
    r.push(this.#p.q.r, this.#p.f(), this.#p?.q.r, this.#n?.q.r, this.#n?.f(), this.#p.q?.['r']);
    r.push(this.#m(), (this.#m)(), (0, this.#m)(), this?.#m(), o?.#m?.(), this.#m`x`);
    r.push(#p in this && #n in this || #c in o, (#p in this) + (#c in this));
    this.#c++; ++this.#c; this.#c += 2; this.#c ??= 9; this.#c ||= 0; this.#c &&= this.#c * 2;
    r.push(this.#c, P.#s++, P.#s, this.#p['q']['r'] += 1, this.#p.q.r);
    this.#p.q = function () {}; r.push(this.#p.q.name);
    return r.join();
  }
}
new P().run(null)
// ---
// Private members in tail position in strict code, and private reads under optional
// call chains whose base is nullish at each link.
class T {
  #f() { return this.#g?.(); }
  #g = () => 7;
  #h = null;
  a() { return this.#f(); }
  b() { return this.#h?.(); }
  c() { return this.#h?.x.y(); }
  d(o) { return o?.#f()?.toString?.(); }
  e() { return this.#g`t`; }
  f(x) { return x ? this.#f() : this.#h?.(); }
  g(x) { return (x && this.#f() || this.#h) ?? this.#g(); }
}
var t = new T();
[t.a(), t.b(), t.c(), t.d(t), t.d(null), t.e(), t.f(1), t.f(0), t.g(1), t.g(0)].join()
// ---
// `super` in chains: property and computed reads, calls, optional calls, tagged
// templates, updates and compound assignments (MemberAtThis with flag 1 and `super`).
class A {
  constructor() { this.v = 1; this.w = { x: 2 }; }
  m() { return this.v; }
  get g() { return 'g'; }
  t(s, ...v) { return s.raw.join('/') + v.join(); }
  o() { return null; }
}
class B extends A {
  constructor() { super(); this.k = 'm'; }
  run() {
    var r = [super.m(), super['m'](), super[this.k](), super.m?.(), super.o?.()?.x, super.zz?.()];
    r.push(super.t`a${1}b`, super['t']`c`, super.g, super['g'], super.w, typeof super.m);
    super.v = 5; r.push(this.v);
    super['v'] += 3; r.push(this.v);
    super.v++; r.push(this.v);
    ++super[this.k + 'x']; r.push(this.mx);
    super.u ??= 4; r.push(this.u);
    return r.join();
  }
  tail() { 'use strict'; return super.m(); }
  tail2() { return super[this.k](); }
  tail3(x) { return x ? super.m() : super.t`z`; }
}
var b = new B();
[b.run(), b.tail(), b.tail2(), b.tail3(1), b.tail3(0)].join('|')
// ---
// Object-literal methods with `super`, arrows capturing `super` and `this` in chains.
var proto = { m() { return 'p' + this.n; }, k: { j() { return 'k'; } } };
var o = {
  __proto__: proto, n: 1,
  a() { return super.m() + super.k.j() + super['k']['j']() + (() => super.m())(); },
  b() { return (() => () => super.m?.())()(); },
};
[o.a(), o.b()].join()
// ---
// Optional call chains: `?.()` repeated, chains nested in arguments and computed keys,
// parenthesized chains as callees (ChainThis via a single-item Expressions), and
// sequence callees (the Expressions fallback).
var o = { f() { return o; }, g: null, h() { return this === o; }, k: 'h', a: [() => 1] };
var r = [o.f?.()?.f?.()?.h(), o?.f?.().g?.(), o.f?.(o.g?.(), o?.f?.().k)?.h?.(),
  o[o?.k]?.(), o?.[o.f?.().k]?.(), (o?.f)(), (o?.h)(), ((o?.h))(), (0, o.h)(),
  (o.f(), o.h)(), o.a?.[0]?.(), o.a?.[0](), o.f?.().a?.[0]?.(), (o?.a)[0]()];
var s = o.g?.()?.(); var t = o?.zz?.()?.()?.();
String(r) + s + t
// ---
// flags: --compile-only
// Nullish bases under a parenthesized chain callee and a doubled optional call: HEAD
// mis-codes these at run time (see the review), so they are compared compiled only.
var a = null, o = { g: null };
(a?.b)(); (a?.b.c)(); (o.g?.x)?.(); String(o.g?.()?.()); String(a?.()?.()?.());
function f() { 'use strict'; return (a?.b)?.(o.g?.()?.()); }
// ---
// Optional chains inside conditional/logical tails in strict functions, so RUN_TAIL
// lands inside a chain's short-circuit.
'use strict';
var o = { f(x) { return x; }, n: null };
function a(x) { return o.f?.(x); }
function b(x) { return o.n?.f(x); }
function c(x) { return x ? o?.f(x) : o.n?.(x); }
function d(x) { return x && o.f?.(o.f?.(x)) || o?.f?.(0); }
function e(x) { return (o.f(1), o.n?.[x]?.(x)); }
function f(x) { return x ?? o?.['f']?.(2); }
function g(x) { return typeof o.f?.(x); }
function h(x) { return o.f`${x}`; }
var tag = (s, v) => v;
function i(x) { return tag`${x}`; }
function j(x) { return eval?.('x') }
[a(1), b(1), c(1), c(0), d(1), d(0), e('f'), f(null), g(1), h(3), i(4)].join()
// ---
// `using` blocks with chains inside, nested, in functions and loops, with early exits.
var log = [];
function res(n) { return { [Symbol.dispose]() { log.push('d' + n); }, v: { w: { m() { return n; } } } }; }
{
  using a = res(1);
  log.push(a.v.w.m(), a?.v?.w?.m?.());
  {
    using b = res(2), c = null;
    if (b.v.w.m() === 2) { using d = res(3); log.push(d.v.w.m()); } else log.push('x');
  }
}
function f(n) {
  using r = res(n);
  if (n > 1) { using s = res(n * 10); return s.v.w.m() + r.v.w.m(); }
  return r.v.w.m();
}
log.push(f(1), f(2));
for (let i = 0; i < 2; i++) { using q = res(100 + i); log.push(q.v.w.m()); if (i) break; }
log.join()
// ---
// flags: --compile-only
// `await using` in an async function and an async arrow, with chains and tail returns.
async function f(o) {
  await using a = o.r?.(), b = o.s;
  { await using c = o.t.u.v(); if (c) return o.w?.x(); else return a?.b.c; }
}
var g = async (o) => { { await using x = o?.a; return x.b`c`; } };
// ---
// flags: --eval-compiler
// `with` bodies: chains, calls, tagged templates and assignments on the symbol path, an
// `if` and logical chain inside, and a direct eval in a chain under `with`.
var w = { p: { q() { return this === w.p ? 'q' : 'x'; }, r: 1 }, f() { return typeof this; }, t(s) { return s[0]; } };
var r = [];
with (w) {
  r.push(p.q(), p?.q(), p['q'](), f(), t`tt`, p.r && p.q() || 0, p.r ? f() : 0, typeof p.zz?.y);
  if (p.r) r.push(p.r += 1); else if (p) r.push(0); else r.push(-1);
  nv = function () {}; r.push(typeof nv, nv.name);
  p.s = p.q; r.push(p.s());
  r.push(eval('p.q()'), eval('p').q(), eval?.('typeof p'));
}
function g(o) { with (o) { return p.q() + f() + t`u`; } }
r.push(g(w));
r.join()
// ---
// flags: --eval-compiler
// Direct eval in chains: as a callee of further calls, members and tags, under optional
// calls, in strict tail position (EVAL_TAIL), and shadowed or parenthesized (still direct).
var v = 'g';
function f() { return 'f'; }
function a() { var v = 'a'; return eval('f')() + eval('({v})').v + eval('[v]')[0] + eval?.('v'); }
function b() { 'use strict'; var v = 'b'; return eval('v'); }
function c() { 'use strict'; var v = 'c'; return v ? eval('v') : eval('0'); }
function d() { var v = 'd'; return (eval)('v') + (0, eval)('v') + eval('v').toUpperCase(); }
function e() { var eval = function (s) { return 'shadow:' + s; }; return eval('v'); }
function g() { var v = 'g2'; return eval(`v`) + eval('`${v}`') + eval('v', 'ignored'); }
function h() { var o = { eval }; var v = 'h'; return o.eval('v') + eval('eval')('v'); }
[a(), b(), c(), d(), g(), h()].join() + typeof e
// ---
// flags: --eval-compiler
// Program-level `if` (each arm sets the result) inside eval, blocks, labels and loops, with
// function declarations, class and `let` in the arms; and the completion value of each.
var r = [];
r.push(eval('if (1) 2;'), eval('if (0) 2;'), eval('if (0) 2; else 3;'), eval('3; if (0) 2;'));
r.push(eval('4; if (1) {} else 5;'), eval('if (1) { 6; } else { 7; }'), eval('if (0) ; else if (0) 8; else 9;'));
r.push(eval('l: if (1) { 10; break l; }'), eval('for (var i = 0; i < 2; i++) if (i) i * 11; else 0;'));
r.push(eval('if (1) { let a = 12; a; }'), eval('if (1) { class C {} typeof C; }'), eval('if (1) { function q() {} } typeof q'));
r.push(eval('if (1) if (0) 13; else 14;'), eval('if (0) if (1) 15; else 16;'), eval('17; { if (0) 1; }'));
r.push(eval('do if (1) 18; while (0)'), eval('switch (1) { case 1: if (1) 19; }'), eval('try { if (1) 20; } finally {}'));
function f(x) { if (x) { var y = 1; } else if (x === 0) y = 2; else { let z = 3; y = z; } return y; }
function g(x) { if (x) return 1; if (!x) { if (x === 0) return 2; } else return 3; return 4; }
r.push(f(1), f(0), f(null), g(1), g(0), g(null));
String(r)
// ---
// Statement fusion against assignment shapes: a local, a closure, a destructuring, a
// member, chained assignments, compound and logical assignments, and assignments whose
// value is itself a chain or a conditional.
function s(o) {
  var a, b, c = 0, d = {};
  a = 1;
  a = b = 2;
  [a, b] = [b, a];
  ({ a, b } = { a: 3, b: 4 });
  d.x = a;
  d['y'] = d.x = a = 5;
  c += 1;
  c ||= 9;
  a = o?.p?.q;
  a = o ? o.p : null;
  b = a && a.q || c;
  c = typeof a;
  (function () { a = 6; b = a; })();
  a = class {};
  b = function () {};
  c = () => {};
  return [a.name, b.name, c.name, d.x, d.y].join();
}
s({ p: { q: 1 } })
// ---
// Blocks: nested lexical blocks with function declarations (annex B), class declarations,
// labelled blocks with breaks out of chains, and blocks as `if`/loop bodies.
var r = [];
{ function fa() { return 'fa'; } { let fa = 1; r.push(fa); } r.push(fa()); }
lab: { r.push(1); if (r.length) break lab; r.push(2); }
outer: { inner: { { r.push(typeof fa); break outer; } } r.push('no'); }
{ class K { static k() { return 'k'; } } r.push(K.k()); }
for (let i = 0; i < 2; i++) { let j = i; { const k = j * 2; r.push(k); } }
function h() { { { { return 'deep'; } } } }
r.push(h());
r.join()
// ---
// Chains nested through call arguments and computed keys (the saved chain target), with
// a nullish base at the inner and the outer level.
var o = { f(x) { return x; }, n: null, g() { return o; } };
function id(x) { return x; }
var r = [o?.f(o.n?.f(1)), o.n?.f(o?.f(2)), o?.f(o?.g?.().f(o.n?.x ?? 3)), id(o.n?.a.b.c)?.d,
  o?.[o.n?.k ?? 'f']?.(o?.f(o?.f(o?.f(4)))), o.g?.()[o?.f('f')](o.n?.(5) ?? 6),
  id(id(o)?.g?.()?.n?.(id(o?.n)))];
String(r)
// ---
// Generators and async functions: chains under `yield`, `yield*`, `await`, in tail and
// non-tail returns, and statement-level updates and compounds (the no-value flag).
var log = [];
var o = { a: { b() { return 2; }, c: [1, 2] }, n: null, p: Promise.resolve({ q: { r: 3 } }) };
function* g() { yield o.a.b(); yield o?.a.c[1]; yield* o.a.c; var x = yield o.n?.q; return x?.y ?? o.a.b(); }
for (var v of g()) log.push(v);
async function h() { var t = (await o.p).q.r; t += (await o.p)?.q?.r; return o.n?.x ?? t; }
async function k() { 'use strict'; return (await o.p).q.r; }
var af = async () => (await o.p)?.q.r;
h().then(v => log.push('h' + v)); k().then(v => log.push('k' + v)); af().then(v => log.push('a' + v));
function u() { var a = { b: 1, c: [0] }; a.b++; ++a.c[0]; a.b += 1; a.c[0] ||= 5; for (var i = 0; i < 2; i++, a.b++) a.c[0]--; return [a.b, a.c[0]]; }
log.push(u());
log.join()
// ---
// Class bodies: chains in field initializers, static blocks, computed keys, default
// parameters, destructuring defaults, accessors and heritage expressions.
var o = { a: { b() { return 'b'; }, k: 'kk' }, n: null, base: { C: class { z() { return 'z'; } } } };
class C extends o.base.C {
  [o.a.k] = o.a.b();
  [o?.n?.k ?? 'q'] = o.n?.x;
  static s = o.a?.b?.();
  static { this.t = o.a.b() + (o.n?.y ?? 't'); }
  m(x = o.a.b(), { y = o?.a.k, z = o.n?.z } = {}) { return x + y + z + super.z(); }
  get g() { return o.a.b`g`; }
  set g(v) { o.a.k = v?.w ?? v; }
}
var c = new C();
c.g = { w: 'set' };
[c.kk, c.q, C.s, C.t, c.m(), c.g, o.a.k].join()
// ---
// Destructuring and assignment targets built from chains, assignment chains naming
// functions and classes, and `delete` of chains.
var o = { a: { b: {}, c: [] }, n: null };
var f, g, h;
f = g = function () {};
h = class {};
o.a.b.x = function () {};
[o.a.b.y, o.a.c[0]] = [1, 2];
({ p: o.a.b.z, q: o.a.c[1] = () => {} } = { p: 3 });
var r = [f.name, g.name, h.name, o.a.b.x.name, o.a.b.y, o.a.c[0], o.a.b.z, o.a.c[1].name];
r.push(delete o.a.b.y, delete o?.a.b.z, delete o.n?.a.b, delete o.a?.['c'], 'c' in o.a);
r.join()
// ---
// Parenthesized references under update and compound operators (a single-item
// Expressions forwarding the flag to MemberAt/Member/PrivateMember/super), and sequence
// callees that fall back to an `undefined` receiver.
var a = [1, { b: 2 }], o = { b: 3, m() { return this === o; } };
(a[0])++; ((a[0])) **= 3; (a[1].b) += 4; ((a[1]).b)--; (o['b']) ||= 0; ++(o.b);
class Q extends Object {
  #p = [5];
  run() { (this.#p[0])++; (this.#p)[0] += 1; (super[0]) ??= 1; (super.x) = 2; return this.#p[0]; }
}
var r = [a[0], a[1].b, o.b, new Q().run(), (o.m)(), (0, o.m)(), (o, o.m)(), (o.m, o).m(), ((o.m))()];
r.join()
// ---
// Chains inside other statements at program level: `switch` discriminants and cases,
// `for-in`/`for-of` with member targets, `try`/`catch`/`finally` and labelled loops,
// each with a program-level `if` chain inside.
var o = { a: { b: [1, 2, 3], c: 'k' }, t: {}, n: null };
var r = [];
switch (o.a.c) { case o.n?.c: r.push('n'); break; case o?.a.c: if (o.a.b[0]) r.push('k'); else if (o.n) r.push('x'); default: r.push('d'); }
for (o.t.k in o.a) r.push(o.t.k);
for (o.t['v'] of o.a.b) if (o.t.v > 1) r.push(o.t.v);
try { o.n.x.y; } catch ({ message }) { if (message) r.push('caught'); } finally { r.push(o?.a?.c); }
outer: for (var i of o.a.b) { for (var j of o.a.b) { if (j > i) continue outer; else if (i === 3) break outer; r.push(i + '' + j); } }
r.join()
// ---
// flags: --eval-compiler
// Each walk arm's chain at the lengths that straddle the tree-depth limit, in eval at
// program level and in a strict function body (tail position), plus mixes of private,
// `super`, optional and tagged links; the outcome is the value or the error's name.
function F() { return F; }
F.b = F; F.c = F; F[0] = F; F.d = function () { return F; };
var shapes = {
  member: n => 'F' + '.b'.repeat(n),
  computed: n => 'F' + '[0]'.repeat(n),
  call: n => 'F' + '()'.repeat(n),
  tagged: n => 'F' + '.b``'.repeat(n >> 1),
  mcall: n => 'F' + '.d()'.repeat(n >> 1),
  optional: n => 'F' + '?.b?.()'.repeat(n >> 2),
  and: n => 'F' + ' && F'.repeat(n),
  coalesce: n => 'F' + ' ?? F'.repeat(n),
  plus: n => '1' + ' + 1'.repeat(n),
  elseif: n => 'if (!F) 1; ' + 'else if (!F) 1; '.repeat(n) + 'else 2;',
};
var out = [];
for (var k in shapes) {
  for (var n of [2040, 2042, 2043, 2044, 2046, 2048]) {
    var e = shapes[k](n), s = k === 'elseif' ? e : e + ';';
    var b = k === 'elseif' ? '(function () { "use strict"; ' + e.replace(/ (\d);/g, ' return $1;') + ' })()'
                           : '(function () { "use strict"; return ' + e + '; })()';
    for (var src of [s, b]) {
      try { var v = eval(src); out.push(typeof v === 'function' ? 'f' : String(v)); }
      catch (x) { out.push(x.name[0]); }
    }
  }
}
// Private and `super` links: direct eval cannot see them from a method, so the whole
// class is the eval'd source.
for (var n of [100, 253, 254, 255, 256]) {
  try {
    var P = eval('(class extends Object { #p = this; c() { return this; } m() { return this' +
      '.#p.c()?.#p[0]?.c'.repeat(n) + ' ?? super.toString`x`; } })');
    out.push(typeof new P().m());
  } catch (x) { out.push(x.name); }
}
out.join('')
