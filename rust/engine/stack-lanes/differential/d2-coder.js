// D2: the coder's walk. Member, computed, private and super accesses mixed with calls, optional
// links and tagged templates in one chain, at program level and in a function body; run so
// the values are compared too.
var log = [];
var o = { a: { b: { c: function () { return this === o.a.b ? 'b' : 'x'; } } }, k: [1, [2, [3]]] };
function t(s) { return function (t2) { return function () { return s.raw.join() + t2.raw.length; }; }; }
o.f = function () { return { g: function () { return { h: o }; } }; };
log.push(o.a.b.c(), o['a']['b']['c'](), o.k[1][1][0], o.f().g().h.a.b.c());
log.push(t`x``y`(), typeof t`a${1}b```);
log.push(o?.a?.b?.c(), o?.zz?.b.c(), o.zz?.(), o?.['k']?.[1]?.[0], o.a?.b.c?.());
function body() {
  var r = o.a.b.c() + o?.k[1][1][0] + (o.zz?.q ?? 'n') + t`q``r`();
  var s;
  s = r;
  s = o.k[0] = o.k[1][0];
  return [r, s, o.k[0]].join();
}
log.push(body());
class A { #p = { q: { r: 3 } }; m() { return this.#p.q.r + (this.#p?.q).r; } get g() { return 1; } }
class B extends A { m() { return super.m() + super['m']() + super.g + super['g']; } }
log.push(new B().m());
log.join('|')
// ---
// Logical, conditional and nullish operators in every combination with calls in tail
// position, in arrows and functions, so RUN_TAIL and the branch targets are compared.
var n = 0;
function f(x) { n++; return x; }
function g(a, b, c) { return (a && f(b) || c) ?? f(a); }
var h = (a, b) => a ? f(a) : b ? f(b) : f(0);
function k(a) { return a ?? (a || (a && f(a))); }
function q(a, b) { return (a, b, f(a + b)); }
function w(a) { if (a) return f(1); else if (a === 0) return f(2); else return f(3); }
var r = [g(1, 2, 3), g(0, 2, 3), g(null, 0, null), h(0, 0), h(0, 4), h(5, 0), k(null), k(0), k(7),
  q(1, 2), w(1), w(0), w(null), n];
r.join()
// ---
// `if`/`else if` at program level (each arm sets the result) and in a body, with and without a
// final `else`, with blocks, `let` and `using`-free blocks; the program's result is compared.
var x = 2, y = [];
if (x === 0) y.push(0); else if (x === 1) y.push(1); else if (x === 2) { let z = 2; y.push(z); }
if (x) { y.push('t'); } else { y.push('f'); }
if (!x) y.push('n');
function b(v) {
  if (v === 1) { let a = 1; return a; } else if (v === 2) { const c = 2; { let d = c; return d; } }
  else if (v === 3) return 3;
  if (v) y.push(v);
  return -1;
}
y.push(b(1), b(2), b(3), b(4));
if (x) y.join(); else 'none'
// ---
// Unary operators over chains and chains under unary operators; `typeof` of an undeclared
// member base and of a call; `delete` and `void` beside them.
var o = { a: { b: 1, c: function () { return -1; } } };
var r = [typeof o.a.b, typeof o.a.c(), -o.a.b, +o.a.c(), !o.a, ~o.a.b, void o.a.c(),
  typeof typeof typeof o, - - -o.a.b, !!!o.zz?.q, typeof undeclared, delete o.a.b, o.a.b];
r.join()
// ---
// Statement fusion: an assignment statement to a local or a closure in a body is rewritten to
// the store-and-pop form; to a member it is not.
function s() {
  var a = 0, b = { c: 0 };
  a = 1;
  a = a + 1;
  b.c = a;
  (function () { a = 5; })();
  a = b.c = 9;
  return a + b.c;
}
var cl = 0;
function u() { cl = 3; return function () { cl = cl + 1; return cl; }; }
[s(), u()(), cl].join()
// ---
// flags: --eval-compiler
// Direct and indirect eval as chain links and callees, at program level and in a function, so
// the EVAL and EVAL_TAIL forms and the scoper's poisoning reach the coder.
var v = 1;
function e1() { var v = 2; return eval('v') + (0, eval)('v') + eval('v + 1'); }
function e2() { var v = 3; return eval('v'); }
var o = { e: eval };
[eval('v'), e1(), e2(), o.e('v'), eval?.('v')].join()
// ---
// Optional chains in call position through members, computed keys and calls, with a nullish
// base at each link, so the receiver dance and the short-circuit targets are compared.
var o = { a: { m: function () { return this.v; }, v: 4 }, n: null, f: function () { return o; } };
var r = [o.a?.m(), o.n?.m(), o.zz?.m(), o?.a.m(), o.a?.['m'](), o.n?.['m'](), o.f?.().a.m(),
  o.zz?.().a.m(), o.f?.()?.n?.m(), (o?.a).m(), o?.a?.m?.(), o?.n?.m?.(), o.a.zz?.()];
String(r)
// ---
// Compound and logical assignments through chains (code_this with flag 1), and prefix and
// postfix updates of chained references.
var o = { a: { b: 1, k: [5] }, n: null };
o.a.b += 2; o.a['b'] *= 3; o.a.k[0] -= 1; o.a.zz ??= 7; o.a.b ||= 0; o.a.k[0] &&= 8;
var p = o.a.b++, q = ++o.a.k[0], r = o.a.zz--, s = --o.a['b'];
[o.a.b, o.a.k[0], o.a.zz, p, q, r, s].join()
// ---
// flags: --eval-compiler
// Long mixed chains through eval at depths near the parser's limit: alternating member and call
// links, tagged templates over calls, `&&`/`||` runs, `?:` and `if`/`else if` chains.
function F() { return F; }
F.b = F; F.c = F;
var out = [];
var srcs = [
  'F' + '.b()'.repeat(1000),
  'F' + '()``'.repeat(1000),
  'F' + '?.b'.repeat(500) + '()',
  'F' + '[0]'.repeat(1500),
  '1' + ' && 1 || 0'.repeat(1000),
  '1' + ' ?? 2'.repeat(2000),
  'var a = 1; ' + 'a ? 1 : '.repeat(1000) + '0',
  'var x = 0; if (x) 1; ' + 'else if (x) 1; '.repeat(2000) + 'else 2;',
  '(function () { var x = 0; if (x) return 1; ' + 'else if (x) return 1; '.repeat(1500) + 'return 2; })()',
  'typeof '.repeat(1000) + 'F',
];
for (var i = 0; i < srcs.length; i++) {
  try { var v = eval(srcs[i]); out.push(typeof v === 'function' ? 'fn' : String(v)); }
  catch (e) { out.push(e.name); }
}
out.join()
// ---
// flags: --compile-only
// A member chain at the tree-depth limit and a logical chain over it: the coder walks both
// (the parser refuses a program with any chain past the limit, so none is here).
var F, a;
a = F.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b.b;
a = a && a || a;
// ---
// Untagged templates with chains and tagged templates inside substitutions; a template literal
// with an illegal escape in a tag position.
var o = { a: { b: 'x' } };
function tag(s, ...v) { return s.raw.join('/') + ':' + v.join(','); }
var r = [`${o.a.b}${o.a?.b}-${tag`a${o.a.b}b${tag`c`}`}`, tag`\unicode${1}`, tag`${1}${2}${3}`];
r.join('|')
// ---
// Blocks with `let`, `const` and class declarations, nested and in function bodies, and a
// `with` body coding its chains on the symbol path.
var r = [];
{ let a = 1; { let a = 2; { const a = 3; r.push(a); } r.push(a); } r.push(a); }
function f() { { class C { m() { return 'c'; } } r.push(new C().m()); } { let z = r.length; r.push(z); } }
f();
var w = { p: { q: function () { return 'w'; } } };
with (w) { r.push(p.q(), p?.q(), typeof p.zz); }
r.join()
