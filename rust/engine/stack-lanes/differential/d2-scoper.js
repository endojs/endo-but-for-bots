// D2: the scoper's walks. Closures capturing across many function levels (every function
// between the use and the declaration gets an alias, outermost first), with blocks, catch,
// for, switch and with scopes in between; run so the values are compared too.
var g = 'g';
function f1(a) {
  var v1 = 1;
  return function f2(b) {
    let v2 = 2;
    { let v3 = 3;
      return function f3() {
        try { throw 4; } catch (v4) {
          for (let v5 = 5; v5 < 6; v5++) {
            switch (v5) { case 5: { let v6 = 6;
              return (() => function f4() { return [g, a, v1, b, v2, v3, v4, v5, v6].join(); })()(); } }
          }
        }
      };
    }
  };
}
var o = { a: 'w' };
var w;
with (o) { w = function () { return a; }; }
[f1('a')('b')(), w(), typeof f2, typeof f4].join('|')
// ---
// flags: --eval-compiler
// `arguments` and direct eval: injected before the body when the parser saw them, after it when
// a body-level eval call is found while hoisting; arrows do not inject.
function a1() { return arguments.length; }
function a2(x) { var arguments; return typeof arguments; }
function a3(x) { return eval('arguments.length'); }
function a4(x) { var r = eval('x'); return r + arguments.length; }
function a5(x) { return (() => arguments[0])(); }
function a6(arguments) { return arguments; }
function a7() { 'use strict'; return eval('typeof arguments'); }
function a8(x) { { eval('var y = x'); } return y; }
[a1(1, 2), a2(1), a3(1, 2, 3), a4(5, 6), a5(7), a6(8), a7(), a8(9)].join()
// ---
// Function declarations in blocks, switch cases and labeled blocks (Annex B hoisting), named
// function expressions' self-binding, generators, async functions and defaults.
var r = [];
{ r.push(b1()); function b1() { return 'b1'; } }
switch (1) { case 1: function s1() { return 's1'; } r.push(s1()); }
lab: { r.push(l1()); function l1() { return 'l1'; } }
var fe = function self(n) { return n ? self(n - 1) + 1 : 0; };
r.push(fe(5), typeof self);
function* gen(a = 1, [b, c] = [2, 3], { d } = { d: 4 }) { yield a; yield* [b, c, d]; }
r.push([...gen()].join(''));
var asy = async function (x) { return await x; };
r.push(typeof asy(1).then);
r.join()
// ---
// Classes: instance and static fields, private methods and accessors, a base constructor that
// captures the field initializer, `super(...)` in a derived constructor, static blocks.
class A {
  #x = 1; y = this.#x + 1; static s = 3; static #t = 4;
  static { this.u = A.#t + 1; }
  get #g() { return this.#x * 10; } #m() { return this.#g + this.y; }
  constructor(z) { this.z = z; }
  run() { return [this.#m(), this.y, this.z, A.s, A.u].join(); }
}
class B extends A {
  #w = 9; k = 2;
  constructor() { super(7); this.v = this.#w + this.k; }
  run() { return super.run() + ':' + this.v + ':' + (#w in this); }
}
new B().run()
// ---
// flags: --compile-only
// Early errors the bind walk raises: deleting a private member, a private member on `super`.
class C { #x; m() { delete this.#x; } }
// ---
// flags: --compile-only
class C { #x; m() { return super.#x; } }
// ---
// flags: --compile-only
// A getter with a parameter (object literal: the property's flag is copied to the function).
var o = { get a(x) { return x; } };
// ---
// flags: --compile-only
var o = { set a(x, y) {} };
// ---
// flags: --compile-only
// Hoist-walk early errors: a catch parameter redeclared by `let` in the body, `??` mixed with `||`.
try {} catch (e) { let e; }
// ---
// flags: --compile-only
var x = a ?? b || c;
// ---
// flags: --compile-only
// The first error in pre-order wins: an inner duplicate before an outer one.
function f() { { let q; let q; } let r; let r; }
// ---
// flags: --compile-only
// Duplicate strict parameters, and an undeclared private name.
function f(a, a) { 'use strict'; }
// ---
// flags: --compile-only
class D { m() { return this.#nope; } }
// ---
// Destructuring patterns, spread, rest, for-in/of with let and var, try/finally, postfix updates
// in member chains, yield* delegation, and tagged templates in nested functions.
function d(...rest) {
  var { a, b: [c, ...dd] = [1, 2, 3], ...e } = { a: 0, x: 9 };
  var out = [a, c, dd.join('+'), Object.keys(e).join(), rest.length];
  for (let k in { p: 1, q: 2 }) out.push(k);
  for (var v of [[1, 2]]) { let [m, n] = v; out.push(m + n); }
  try { out.push('t'); } finally { out.push('f'); }
  var o = { c: { n: 1 } };
  o.c.n++; ++o.c.n; o['c'].n--;
  out.push(o.c.n);
  function* gg() { yield* [1, 2]; }
  out.push([...gg(), ...[3, 4]].length);
  var tag = (s, ...v) => s.length + v.length;
  out.push(tag`a${1}b${2}c`);
  return out.join();
}
d(1, 2, 3)
// ---
// flags: --eval-compiler
// Deep nests and chains through eval, each depth near the compiler's limit: nested functions
// with a capture at the bottom, blocks, try, switch, call and `??` chains, tagged templates,
// object patterns and assignment chains.
var out = [];
function wrap(open, core, close, n) { return open.repeat(n) + core + close.repeat(n); }
var srcs = [
  'var top = 1; ' + wrap('(function () { return ', 'top', '; })()', 40),
  'var top = 1; ' + wrap('function f() { ', 'return top;', ' }', 500),
  wrap('{ let b = 1; ', 'b', ' }', 500),
  wrap('try { ', '1', ' } catch (e) {}', 500),
  wrap('switch (1) { case 1: ', '1', ' }', 500),
  'function F() { return F; } F' + '()'.repeat(2000),
  'var a = null; a' + ' ?? a'.repeat(2000),
  'var x = {}; var ' + wrap('{a:', 'a', '}', 500) + ' = x',
  'var a; ' + 'a = '.repeat(1000) + '1',
  'var o = { a: 1 }; with (o) { ' + wrap('with (o) { ', 'a', ' }', 200) + ' }',
  wrap('for (let i = 0; i < 1; i++) { ', '1', ' }', 250),
];
for (var i = 0; i < srcs.length; i++) {
  try { var v = eval(srcs[i]); out.push(typeof v === 'function' ? 'fn' : String(v)); }
  catch (e) { out.push(e.name); }
}
out.join()
// ---
// flags: --eval-compiler
// A 2,000-link tagged-template chain compiles; at run time it overflows the value stack.
function t() { return t; }
typeof eval('t' + '``'.repeat(2000))
