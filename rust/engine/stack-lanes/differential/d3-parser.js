// D3: the binary rungs climbed in one loop, the `new` chain consumed in a loop, and the
// charged productions without a closure. Every operator of the 11 rungs mixed with
// unary, exponentiation, conditional and assignment operands, so each fold, its order
// and its line show in the bytecode and the result.
var a = 6, b = 3, c = 2, o = { p: 1, k: 'p' }, s = [];
s.push(a + b * c - a / c % b, a << c >> 1 >>> 0, a < b == b > c != a <= b === b >= c);
s.push(a & b | c ^ a, a | b & c, a ^ b | c & a, a && b || c && 0 || a, a ?? b ?? c);
s.push(null ?? (a || b), (null ?? a) || b, a || (b ?? c), (-a) ** 2 + -(a ** 2));
s.push(2 ** 3 ** 2, (-2) ** 2, !a + ~b - -c, typeof a + typeof o == 'numberobject');
s.push(a in o || 'p' in o, o instanceof Object && !(a instanceof Object), 'k' in o === true);
s.push((a + b < c * a == b - c > a !== (a & 1 | b ^ c) >= 0 && a || b) ?? c);
s.push(a ? b + c : c * a, a = b + c * 2, a += b << 1, a, b ||= c + 1, b, o.p ??= 9);
s.join()
// ---
// Folds across lines: each node takes its operator's line.
var x = 1
  + 2
  *
  3
  <
  4
  ==
  true
  &&
  5
  ||
  6;
var f = function () { throw new Error('line'); };
var r = [];
try { r.push(x
  +
  f()); } catch (e) { r.push(e.message); }
r.push(x);
r.join()
// ---
// `#x in` at a relational rung's entry: alone, under every lower rung, with a shift
// operand, and followed by operators of the rungs it does and does not loop over.
class C {
  #x = 1;
  static t(o, p) {
    return [#x in o, #x in o && #x in p, #x in o || 0, #x in o == true, #x in o != (#x in p),
      #x in o ? 1 : 2, !(#x in p), (#x in o) + (#x in p), #x in o & 1, #x in o | 0,
      #x in o ^ 1, #x in o ?? 3, #x in o === !(#x in p)].join();
  }
}
C.t(new C(), {})
// ---
// The `for`-header test: `in` and `of` end a `for` head's first expression, and `in`
// is an operator again inside brackets and parentheses and after `?`.
var log = [], o = { a: 1, b: 2 }, n = 0;
for (var k in o) log.push(k);
for (var v of [1, 2]) log.push(v);
for (var i = 0, j = (1 in [1, 2]) ? 1 : 0; i < 2; i++) log.push(i + j);
for (var m = [ 'a' in o ][0]; n < 1; n++) log.push(m);
for (var z = (0, 'b' in o); n < 2; n++) log.push(z);
for (k in o) log.push(k + 1);
log.join()
// ---
// flags: --compile-only
// In a `for` header the relational rung's first operand returns before `in` or `of`,
// though its loop consumes an `in` after a relational operator (XS accepts the second).
for (var a = b in c;;);
// ---
// flags: --compile-only
for (var q = 'a' in o ? 'y' : 'n';;);
// ---
// flags: --compile-only
for (var w = 1 < 2 in o;;);
// ---
// flags: --compile-only
for (a < b in c;;);
// ---
// flags: --compile-only
for (a == b in c);
// ---
// flags: --compile-only
// An escaped `of` in a `for` header, and escaped `in` and `instanceof` operators, all
// refused as escaped keywords: the `for`-header test reads `of` with `is_keyword`, and
// the relational rung matches its operators with `match_token`.
for (a \u006ff b);
// ---
// flags: --compile-only
// An escaped `in` in a `for`-in head: the `for`-header test returns before it, and the
// `for` statement consumes it without the escape check (accepted today).
for (a \u0069n b);
// ---
// flags: --compile-only
a \u0069n b;
// ---
// flags: --compile-only
a < b \u0069nstanceof c;
// ---
// flags: --compile-only
// `#x in` is the relational rung's entry only: refused after a relational operator,
// without `in`, and in a `for` header.
class C { #x; m(o) { return a < #x in o; } }
// ---
// flags: --compile-only
class C { #x; m(o) { return #x; } }
// ---
// flags: --compile-only
class C { #x; m(o) { for (#x in o;;); } }
// ---
// flags: --compile-only
class C { #x; m(o) { return #x in o in p < q; } }
// ---
// flags: --compile-only
// An arrow function as a binary operand is refused at the fold, from either side.
a + () => 1;
// ---
// flags: --compile-only
(() => 1) ?? x => x;
// ---
// flags: --compile-only
a ||
b &&
c => c;
// ---
// `new` chains: members, computed members, templates and arguments at every level,
// finished innermost first, and `new.target` as the innermost operand.
function F(x) { this.x = x === undefined ? 'u' : x; this.g = F; this.t = 0; }
F.prototype.m = function () { return this.x; };
var r = [];
r.push(new F(1).x, new new F().g(2).x, new new new F().g().g(3).x);
r.push(new F, new new F().g, (new new F().g).x);
function G() { return new.target === G ? 'direct' : 'other'; }
function H() { this.v = new new.target.K(); }
H.K = function () { this.w = 'k'; };
r.push(new G() instanceof G, new H().v.w);
var t = function (strs) { return function T() { this.s = strs[0]; }; };
var k = { F: F };
r.push(new (t`a`)().s, new k[`F`](5).x, typeof new k.F);
r.join()
// ---
// Lines of `new` nodes across a chain split over lines.
function F() { throw new Error('ctor'); }
var r = [];
try { new
  new
  F
  ()
  (); } catch (e) { r.push(e.message); }
try { new
  F()
  .x; } catch (e) { r.push(e.message); }
r.join()
// ---
// flags: --compile-only
// `new.target` outside a function, a missing `target`, and an escaped `new`.
new new.target;
// ---
// flags: --compile-only
function f() { return new new.tar; }
// ---
// flags: --compile-only
new \u006eew f;
// ---
// flags: --compile-only
new new f(a
// ---
// flags: --compile-only
new new f[a;
