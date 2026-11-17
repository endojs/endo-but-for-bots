// C7: `SET_PROPERTY` of an ordinary object whose walk reaches a setter that is a user
// function over the same buffer enters the setter's frame in its own dispatch loop, the
// frame holding `[[Set]]`'s light unit with the 16 its nested `dispatch_at` charged, and
// returning as a setter: its result dropped, the value assigned pushed as the assignment's,
// with no meter check. Every kind of setter, on holders and receivers of many kinds,
// including typed arrays assigned their canonical numeric names, which take no setter.
var r = [];
var seen = [];
var o = { set a(v) { seen.push('a:' + v + ':' + (this === o)); }, set b(v) { seen.push(this === o); return 'dropped'; } };
r.push(o.a = 1, o.b = 2);
var child = Object.create(o); r.push(child.a = 3); child.b = 4;
var deepChild = Object.create(Object.create(Object.create(o))); r.push(deepChild.a = 5);
class K { set k(v) { seen.push('k:' + v + ':' + this.constructor.name); } static set s(v) { seen.push('s:' + v + ':' + this.name); } }
class L extends K { set k(v) { seen.push('L>'); super.k = v + 1; } }
r.push(new K().k = 6, new L().k = 7, K.s = 8, L.s = 9);
var d = {}; Object.defineProperty(d, 'arrow', { set: (v) => seen.push('arrow:' + typeof this + v) });
Object.defineProperty(d, 'gen', { set: function* (v) { seen.push('never'); } });
Object.defineProperty(d, 'async', { set: async function (v) { seen.push('async:' + v); } });
Object.defineProperty(d, 'agen', { set: async function* (v) { seen.push('never'); } });
Object.defineProperty(d, 'bound', { set: function (v) { seen.push(this.tag + v); }.bind({ tag: 'bound' }) });
Object.defineProperty(d, 'native', { set: Array.prototype.push });
Object.defineProperty(d, 'proxied', { set: new Proxy(function (v) { seen.push('proxied' + v); }, {}) });
Object.defineProperty(d, 'cls', { set: K });
Object.defineProperty(d, 'noset', { get: function () { return 'g'; } });
r.push(d.arrow = 10, d.gen = 11, d.async = 12, d.agen = 13, d.bound = 14, d.native = 15, d.length, d[0], d.proxied = 16, d.noset = 17, d.noset);
try { d.cls = 18; } catch (e) { r.push('class-setter:' + e.constructor.name); }
(function () { 'use strict'; try { d.noset = 19; } catch (e) { r.push('strict-noset:' + e.constructor.name); } })();
var arr = [1, 2]; Object.defineProperty(arr, 's', { set: function (v) { this.push(v); } }); r.push(arr.s = 3, arr.length, arr[2]);
var fn = function f() {}; Object.defineProperty(fn, 's', { set: function (v) { seen.push(this.name + v); } }); r.push(fn.s = 4, fn.name);
var ta = new Uint8Array(2); Object.defineProperty(ta, 's', { set: function (v) { this[0] = v; } }); r.push(ta.s = 5, ta[0]);
var inheritsTa = Object.create(new Uint8Array(2)); inheritsTa[0] = 6; inheritsTa[5] = 7; r.push(Object.keys(inheritsTa).join('/'));
var numericTa = new Float64Array(2); numericTa.NaN = 1; numericTa.Infinity = 2; numericTa.x = 3;
var numericChild = Object.create(numericTa); numericChild.NaN = 4; numericChild.Infinity = 5; numericChild.y = 6;
r.push(Object.keys(numericTa).join('/'), numericTa.NaN, numericTa.Infinity, Object.keys(numericChild).join('/'), numericChild.NaN, numericChild.y);
(function () { 'use strict'; numericTa.NaN = { valueOf: function () { seen.push('valueOf'); return 7; } }; numericChild.Infinity = 8; r.push('strict-ta-ok'); })();
Object.defineProperty(Object.prototype, 'Infinity', { get: function () { return 'leak'; }, set: function (v) { seen.push('leak' + v); }, configurable: true });
numericTa.Infinity = 9; numericChild.Infinity = 10; r.push(numericTa.Infinity, numericChild.Infinity, ({}).Infinity); delete Object.prototype.Infinity;
var str = new String('ab'); Object.defineProperty(str, 's', { set: function (v) { seen.push(this.length + v); } }); r.push(str.s = 8);
var px = new Proxy({ set v(x) { seen.push('pv' + x); } }, {}); r.push(px.v = 9, Object.create(px).v = 10);
var trapped = Object.create(new Proxy({}, { set: function (t, k, v, rcv) { seen.push('trap:' + String(k) + v); return true; } })); r.push(trapped.zz = 11);
var frozen = Object.freeze({ set f(v) { seen.push('frozen' + v); }, data: 1 }); r.push(frozen.f = 12, frozen.data = 13, frozen.data);
(function () { 'use strict'; try { frozen.data = 14; } catch (e) { r.push('strict-frozen:' + e.constructor.name); } })();
Object.defineProperty(Number.prototype, 'ns', { set: function (v) { seen.push('ns' + typeof this); }, configurable: true });
r.push((5).ns = 15); delete Number.prototype.ns;
var reassign = { set p(v) { v = 'changed'; arguments[0] = 'changed2'; seen.push(arguments.length); } }; r.push(reassign.p = 'orig');
(function () { 'use strict'; var so = { set t(v) { seen.push(typeof this + ':' + v); } }; r.push(so.t = 16); })();
r.join(' ') + ' | ' + seen.join(' ')
// ---
// The assignment's value amid pending operands, chained, compound, logical, updating,
// destructuring and iterating assignments, and a setter beside a getter.
var log = [];
var cell = 1;
var o = { get x() { log.push('get'); return cell; }, set x(v) { log.push('set' + v); cell = v * 10; return 'no'; } };
var r = [0, o.x = 5, 2].join();
r += ';' + (o.x = o.x = 3) + ',' + cell;
r += ';' + (o.x += 1) + ',' + cell;
r += ';' + (o.x++) + ',' + (++o.x) + ',' + cell;
r += ';' + (o.x ||= 7) + ',' + (o.x &&= 8) + ',' + (o.x ??= 9) + ',' + cell;
({ a: o.x } = { a: 4 }); [o.x] = [5]; r += ';' + cell;
for (o.x of [1, 2]) {} for (o.x in { k: 1 }) {} r += ';' + cell;
r += ';' + `${o.x = 6}|${cell}` + ';' + (o.x = 2) * 3 + ';' + typeof (o.x = 'm');
function g(a, b, c) { return [a, b, c].join('/'); }
r += ';' + g(1, o.x = 7, 3) + ';' + g(...[o.x = 8], o.x = 9);
r + ' | ' + log.join()
// ---
// flags: --eval-compiler
// Setters defined by `eval` and `Function` (another segment), `with`, and a nest through an
// eval-defined setter.
var r = [];
var ev = eval('({ set e(v) { r.push("eval:" + v); } })'); r.push(ev.e = 1);
var fo = Function('r', 'return { set f(v) { r.push("fn:" + v); } };')(r); r.push(fo.f = 2);
var w = { set w(v) { r.push('with:' + v); } };
with (w) { w = 3; }
var nest = eval('(function nest(n) { var res; var q = { set g(v) { res = n > 0 ? nest(n - 1) + 1 : 0; } }; q.g = 0; return res; })');
r.push(nest(50));
function local(n) { var res; var q = { set g(v) { res = n > 0 ? local(n - 1) + 1 : 0; } }; q.g = 0; return res; }
r.push(eval('local(50)'), Function('return local(50)')());
r.join()
// ---
// A setter nest at its ceiling and one past it: the refusal happens at the same level.
function f(n) { var r; var o = { set x(v) { r = n > 0 ? f(n - 1) : 'bottom'; } }; o.x = 0; return r; }
var out = [];
try { out.push(f(100)); } catch (e) { out.push('caught'); }
out.push(f(118));
out.join()
// ---
function f(n) { var r; var o = { set x(v) { r = n > 0 ? f(n - 1) : 'bottom'; } }; o.x = 0; return r; }
try { f(119); } catch (e) { 'caught'; }
// ---
function f(n) { var r; var o = { set x(v) { r = n > 0 ? f(n - 1) : 'bottom'; } }; o.x = 0; return r; }
try { f(120); } catch (e) { 'caught'; }
// ---
// Inherited setters at depth, a class setter nest, and setters mixed with getters, bound,
// Proxy and `Reflect` levels.
var res = [];
var proto = { set x(v) { this.out = this.n > 0 ? (mk(this.n - 1).x = v) && 1 : 'bottom'; } };
function mk(n) { var o = Object.create(Object.create(proto)); o.n = n; return o; }
var top = mk(100); top.x = 1; res.push(top.out);
class G { constructor(n) { this.n = n; } set x(v) { this.r = this.n > 0 ? (new G(this.n - 1).x = v) : 'g'; } }
var gg = new G(110); gg.x = 'v'; res.push(gg.r);
function mix(n) { if (n <= 0) return 0; switch (n % 5) { case 0: var r; ({ set v(x) { r = mix(n - 1) + 1; } }).v = 0; return r; case 1: return mix.bind(null, n - 1)() + 1; case 2: return new Proxy(mix, {})(n - 1) + 1; case 3: return { get v() { return mix(n - 1) + 1; } }.v; default: return Reflect.apply(mix, null, [n - 1]) + 1; } }
res.push(mix(80));
res.join()
// ---
// Throws from inside setter levels: caught by the setter, by an intermediate level, and by
// the outermost caller; then a nest that needs most of the budget.
var log = [];
function f(n, at) { if (n === at) throw new Error('at' + n); var r; ({ set x(v) { r = n > 0 ? f(n - 1, at) : 'ok'; } }).x = 0; return r; }
function h(n, at, catchAt) { if (n === catchAt) { try { return f(n, at); } catch (e) { return 'caught:' + e.message; } } var r; ({ set x(v) { r = n > 0 ? h(n - 1, at, catchAt) : f(0, at); } }).x = 0; return r; }
log.push(h(60, 10, 40), h(60, 0, 59));
try { f(90, 3); } catch (e) { log.push(e.message); }
function deep(n) { var r; ({ set x(v) { r = n > 0 ? deep(n - 1) : n; } }).x = 0; return r; }
log.push(deep(118));
log.join()
// ---
// flags: --eval-compiler
// Throws escaping setter levels through the natives and drivers that catch a guest throw
// (a promise executor, `eval`, a generator, an async function) and through callbacks of
// natives that do not and `Reflect.set`; then the budget probe, also from a job.
var log = [];
function thrower(n) { ({ set x(v) { if (n > 0) thrower(n - 1); else (function () { throw new TypeError('deep'); })(); } }).x = 0; }
new Promise(function () { thrower(40); }).catch(function (e) { log.push('promise:' + e.message); });
try { eval('thrower(40)'); } catch (e) { log.push('eval:' + e.message); }
function* gn() { yield 1; thrower(40); }
var it = gn(); it.next();
try { it.next(); } catch (e) { log.push('gen:' + e.message); }
async function an() { thrower(40); }
an().catch(function (e) { log.push('async:' + e.message); });
try { JSON.stringify({ a: 1 }, function (k, v) { if (k === 'a') thrower(40); return v; }); } catch (e) { log.push('replacer:' + e.message); }
try { [3, 1, 2].sort(function () { thrower(40); }); } catch (e) { log.push('sort:' + e.message); }
try { [1].forEach(function () { thrower(40); }); } catch (e) { log.push('forEach:' + e.message); }
try { Reflect.set({ set s(v) { thrower(40); } }, 's', 1); } catch (e) { log.push('Reflect.set:' + e.message); }
function deep(n) { var r; ({ set x(v) { r = n > 0 ? deep(n - 1) : n; } }).x = 0; return r; }
log.push(deep(118));
Promise.resolve().then(function () { log.push(deep(118)); });
log
// ---
// A value-stack overflow under setter levels halts where it did.
function deep() { return deep(); }
function f(n) { ({ set x(v) { if (n > 0) f(n - 1); else deep(); } }).x = 0; }
f(40)
// ---
var a = []; for (var i = 0; i < 40; i++) a.push(i);
function g() { ({ set x(v) { h(...a); } }).x = 0; }
function h() { return g(); }
g()
// ---
function deep(n, p, q) { var l1, l2, l3, l4; return deep(n + 1, p, q); }
function f(n) { ({ set x(v) { if (n > 0) f(n - 1); else deep(0, v, v); } }).x = n; }
f(25)
// ---
// Throws from inside explicit-stack walks caught below a setter frame, 200 times; then the
// budget probe.
var r = [];
var hole = [1]; Object.defineProperty(hole, 0, { get: function () { throw 3; } });
var w = {
  set p(v) { JSON.parse('{'); },
  set s(v) { JSON.stringify({ toJSON: function () { throw 1; } }); },
  set v(x) { JSON.parse('{"a":[1]}', function (k, x) { if (k === 'a') throw 2; return x; }); },
  set fl(v) { [hole].flat(); },
  set fm(v) { [[1]].flatMap(function () { throw 4; }); },
};
for (var k of ['p', 's', 'v', 'fl', 'fm']) for (var i = 0; i < 200; i++) { try { w[k] = i; } catch (e) {} }
for (var i = 0; i < 200; i++) { try { w.p = i; } catch (e) {} try { w.fm = i; } catch (e) {} }
function deep(n) { var r; ({ set x(v) { r = n > 0 ? deep(n - 1) : 'deep'; } }).x = 0; return r; }
r.push(deep(118));
r.join()
// ---
// The render of a thrown deeply nested array is the same at any setter depth, and of a
// completion value built after a setter nest returned.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { ({ set x(v) { if (n === 0) throw nest(2040); f(n - 1); } }).x = 0; }
f(100)
// ---
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { ({ set x(v) { if (n > 0) f(n - 1); } }).x = 0; }
f(110); nest(2040)
// ---
// A stack trace taken in a setter names the same frames.
var trace;
function inner() { trace = new Error('t').stack; }
var o = { set mid(v) { inner(); } };
function outer() { ({ set top(v) { o.mid = v; } }).top = 1; return trace; }
outer()
// ---
// Meter-heavy setter loops: 55,000 short setter calls, among which the loop's meter checks
// fall.
var n = 0, o = { set x(v) { n += v; } };
for (var i = 0; i < 20000; i++) o.x = 1;
var c = Object.create(Object.create(o));
for (var i = 0; i < 20000; i++) c.x = 2;
for (var i = 0; i < 5000; i++) { o.x = 1; c.x = o.x = 3; }
n
