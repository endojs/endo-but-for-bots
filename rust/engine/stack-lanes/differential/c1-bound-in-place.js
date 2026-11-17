// C1: `RUN` of a bound function whose target is a user function over the same buffer
// enters the target's frame in its own dispatch loop, the frame holding the 16 units the
// nested `dispatch_at` charged. Every kind of target, receiver and argument list.
'use strict';
var r = [];
function show() { return [typeof this, this && this.k, arguments.length, [].slice.call(arguments).join('|')].join(':'); }
var o = { k: 'o' };
r.push(show.bind(o)(), show.bind(o, 1)(2, 3), show.bind(null).bind(o, 'a').bind(o, 'b')('c'));
r.push((function () { return this; }).bind(undefined)() === undefined);
var arrow = (x) => [typeof this, x];
r.push(arrow.bind(o, 5)().join());
function Ctor(a) { if (!new.target) return 'call:' + a; this.a = a; }
r.push(Ctor.bind(null, 1)(), new (Ctor.bind(null, 2))().a);
class K { m() { return 1; } }
try { K.bind(null)(); } catch (e) { r.push(e.constructor.name); }
function* gen(a) { yield a; yield a + 1; }
r.push([...gen.bind(null, 7)()].join());
async function af(a) { return a * 2; }
r.push(af.bind(null, 4)() instanceof Promise);
r.push(Math.max.bind(null, 1)(5, 3), [].concat.bind([1])(2).join());
var bb = show.bind(o, 1); r.push(bb.call(null, 2), bb.apply(null, [2, 3]), Reflect.apply(bb, null, [4]));
function rec(n) { return n ? recb(n - 1) + 1 : 0; }
var recb = rec.bind(null);
r.push(recb(100));
function args() { return arguments.length + ':' + Array.prototype.join.call(arguments); }
r.push(args.bind(null, 1, 2).bind(null, 3)(4, 5));
r.join(' ')
// ---
// A bound nest at its ceiling and one past it, in a function that catches: the refusal
// happens at the same level and is not catchable.
function f(n) { return n > 0 ? f.bind(null, n - 1)() : 'bottom'; }
var r = [];
try { r.push(f(120)); } catch (e) { r.push('caught'); }
r.push(f(126));
r.join()
// ---
function f(n) { return n > 0 ? f.bind(null, n - 1)() : 'bottom'; }
try { f(128); } catch (e) { 'caught'; }
// ---
// Throws from inside bound levels: caught by the callee, by an intermediate level, and
// by the outermost caller; then a nest that needs most of the budget, which completes
// only if every level gave its units back.
var log = [];
function f(n, at) { if (n === at) throw new Error('at' + n); return n > 0 ? g(n - 1, at) : 'ok'; }
var g = f.bind(null);
function h(n, at, catchAt) { if (n === catchAt) { try { return g(n, at); } catch (e) { return 'caught:' + e.message; } } return n > 0 ? hb(n - 1, at, catchAt) : g(0, at); }
var hb = h.bind(null);
log.push(hb(60, 10, 40), hb(60, 0, 59));
try { g(90, 3); } catch (e) { log.push(e.message); }
function deep(n) { return n > 0 ? deep.bind(null, n - 1)() : n; }
log.push(deep(120));
log.join()
// ---
// flags: --eval-compiler
// Throws escaping in-place levels through every native that catches a guest throw: a
// Promise executor, `eval`, a generator body, an async function body, a JSON replacer
// and reviver, a sort comparator and an Array callback; then the budget probe.
var log = [];
function thrower(n) { return n > 0 ? tb(n - 1) : (function () { throw new TypeError('deep'); })(); }
var tb = thrower.bind(null);
new Promise(function () { tb(50); }).catch(function (e) { log.push('promise:' + e.message); });
try { eval('tb(50)'); } catch (e) { log.push('eval:' + e.message); }
try { eval('(function () { return tb(50); })')(); } catch (e) { log.push('eval-fn:' + e.message); }
function* gn() { yield 1; tb(50); }
var it = gn(); it.next();
try { it.next(); } catch (e) { log.push('gen:' + e.message); }
async function an() { tb(50); }
an().catch(function (e) { log.push('async:' + e.message); });
try { JSON.stringify({ a: 1 }, function (k, v) { if (k === 'a') tb(50); return v; }); } catch (e) { log.push('replacer:' + e.message); }
try { JSON.parse('{"a":1}', function (k, v) { if (k === 'a') tb(50); return v; }); } catch (e) { log.push('reviver:' + e.message); }
try { [3, 1, 2].sort(function () { tb(50); }); } catch (e) { log.push('sort:' + e.message); }
try { [1].forEach(function () { tb(50); }); } catch (e) { log.push('forEach:' + e.message); }
function deep(n) { return n > 0 ? deep.bind(null, n - 1)() : n; }
log.push(deep(120));
Promise.resolve().then(function () { log.push(deep(120)); });
log
// ---
// A value-stack overflow under bound levels halts where it did.
function deep() { return deep(); }
function f(n) { return n > 0 ? f.bind(null, n - 1)() : deep(); }
f(40)
// ---
// The render of a thrown deeply nested array is the same at any bound depth: the halt
// releases every level's units before the value is rendered.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { if (n === 0) throw nest(2040); return f.bind(null, n - 1)(); }
f(100)
// ---
// And of a completion value built after a bound nest returned.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { return n > 0 ? f.bind(null, n - 1)() : 0; }
f(120); nest(2040)
// ---
// A stack trace taken in a bound callee names the same frames.
function inner() { return new Error('t').stack; }
function mid() { return inner.bind(null)(); }
var outer = mid.bind(null);
outer()
// ---
// Bound calls mixed with getters, Proxy traps, forEach and generators inside the nest.
var log = [];
var obj = { get v() { return gb(3); } };
function g(n) { return n > 0 ? gb(n - 1) + 1 : [1].map(function () { return 0; })[0]; }
var gb = g.bind(null);
var px = new Proxy({}, { get: function () { return gb(4); } });
function* gg() { yield gb(5); }
log.push(obj.v, px.anything, gg().next().value);
function mix(n) { return n > 0 ? (n % 3 === 0 ? obj.v + mixb(n - 1) : n % 3 === 1 ? px.z + mixb(n - 1) : [n].map(function () { return mixb(n - 1); })[0]) : 0; }
var mixb = mix.bind(null);
log.push(mixb(30));
log.join()
// ---
// flags: --eval-compiler
// Targets in another code segment (defined by `eval` or `Function`) still run in a nested
// loop; a nest through them, and a nest of in-place levels inside one.
var r = [];
var ev = eval('(function (a) { return "eval:" + a; })');
r.push(ev.bind(null, 'x')(), Function('a', 'return "fn:" + a').bind(null, 'y')());
var ef = eval('(function ef(n) { return n > 0 ? efb(n - 1) + 1 : 0; })');
var efb = ef.bind(null);
r.push(efb(100));
function local(n) { return n > 0 ? localb(n - 1) + 1 : 0; }
var localb = local.bind(null);
r.push(eval('localb(100)'), Function('return localb(100)')());
r.join()
// ---
// Throws from inside an explicit-stack walk (JSON.parse, JSON.stringify's toJSON, a
// reviver, `flat` over a throwing getter, a flatMap callback) caught below the bound
// frame that called the walk, 200 times: each pop of that frame inside the walk released
// its units, and the walk's restore must not charge them again (the pre-commit review's
// regression).
var r = [];
function p(x) { return JSON.parse(x); }
var pb = p.bind(null);
for (var i = 0; i < 200; i++) { try { pb('{'); } catch (e) {} }
function s(x) { return JSON.stringify(x); }
var sb = s.bind(null);
var bad = { toJSON: function () { throw 1; } };
for (var i = 0; i < 200; i++) { try { sb(bad); } catch (e) {} }
function v(x) { return JSON.parse(x, function (k, w) { if (k === 'a') throw 2; return w; }); }
var vb = v.bind(null);
for (var i = 0; i < 200; i++) { try { vb('{"a":[1]}'); } catch (e) {} }
function fl(x) { return [x].flat(); }
var flb = fl.bind(null);
var hole = [1]; Object.defineProperty(hole, 0, { get: function () { throw 3; } });
for (var i = 0; i < 200; i++) { try { flb(hole); } catch (e) {} }
function fm() { return [[1]].flatMap(function () { throw 4; }); }
var fmb = fm.bind(null);
for (var i = 0; i < 200; i++) { try { fmb(); } catch (e) {} }
function deep(n) { return n > 0 ? deep.bind(null, n - 1)() : 'deep'; }
r.push(deep(126));
r.join()
// ---
// The same, then a completion value that needs nearly the whole render budget.
function f(n) {
  if (n > 0) return f.bind(null, n - 1)();
  return [[1]].flatMap(function (x) { throw 1; });
}
try { f(100); } catch (e) {}
var a = [1]; for (var i = 0; i < 2040; i++) a = [a];
a

