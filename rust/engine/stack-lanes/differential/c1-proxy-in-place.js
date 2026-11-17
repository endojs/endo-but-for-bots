// C1: `RUN` of a Proxy whose `apply` trap, or the target a trap-less layer forwards to, is
// a user function over the same buffer enters that function's frame in its own dispatch
// loop, the frame holding the layer's light unit with the 16 its nested `dispatch_at`
// charged. Every kind of trap and target, receiver and argument list.
'use strict';
var r = [];
function show() { return [typeof this, this && this.k, arguments.length, [].slice.call(arguments, 0, 2).map(String).join('|')].join(':'); }
var o = { k: 'o' };
var trapShow = new Proxy(function () {}, { apply: show });
r.push(trapShow(), trapShow(1, 2), trapShow.call(o, 3));
o.p = trapShow; r.push(o.p(4));
var fwd = new Proxy(show, {});
r.push(fwd(), fwd(1, 2), fwd.call(o, 3), fwd.apply(o, [4, 5]), Reflect.apply(fwd, o, [6]));
o.q = fwd; r.push(o.q(7));
r.push(new Proxy(fwd, {})(8), new Proxy(trapShow, {})(9), new Proxy(fwd, { apply: undefined })(10));
r.push(new Proxy(show, { apply: function (t, self, args) { return 'trap:' + (self === o) + ':' + args.length + ':' + (t === show); } }).call(o, 1, 2));
var arrow = (t, self, args) => [typeof this, args.join()].join();
r.push(new Proxy(function () {}, { apply: arrow })(1, 2));
class K { m() { return 1; } }
try { new Proxy(K, {})(); } catch (e) { r.push('fwd-class:' + e.constructor.name); }
try { new Proxy(function () {}, { apply: K })(); } catch (e) { r.push('trap-class:' + e.constructor.name); }
function* gen(t, self, args) { yield args[0]; yield args[0] + 1; }
r.push([...new Proxy(function () {}, { apply: gen })(7)].join());
function* g2(a) { yield a; }
r.push([...new Proxy(g2, {})(8)].join());
async function af(t, self, args) { return args[0] * 2; }
r.push(new Proxy(function () {}, { apply: af })(4) instanceof Promise);
r.push(new Proxy(Math.max, {})(1, 5, 3), new Proxy(function () {}, { apply: Reflect.apply })(show, o, [1]));
r.push(new Proxy(function () {}, { apply: show.bind(o, 'b') })(1), new Proxy(show.bind(o, 'c'), {})(2));
function rec(n) { return n ? recp(n - 1) + 1 : 0; }
var recp = new Proxy(rec, {});
var rect = new Proxy(function () {}, { apply: function (t, self, args) { return args[0] ? rect(args[0] - 1) + 1 : 0; } });
r.push(recp(100), rect(100));
function args() { return arguments.length + ':' + Array.prototype.join.call(arguments); }
r.push(new Proxy(args, {})(...[1, 2, 3]), new Proxy(args, {})(), new Proxy(args, {})?.(4));
function tag(s, v) { return s.raw.join('_') + v; }
r.push(new Proxy(tag, {})`a${1}b`);
r.join(' ')
// ---
// Sloppy-mode receivers: the forwarded target's `this` is coerced as before, and the
// trap's is the handler.
var r = [];
function who() { return this === globalThis ? 'global' : typeof this; }
var handler = { apply: function () { return this === handler; } };
r.push(new Proxy(who, {})(), new Proxy(who, {}).call(1), new Proxy(function () {}, handler)());
var obj = { m: new Proxy(who, {}) };
r.push(obj.m());
r.join()
// ---
// The trap as the handler finds it: from a getter, from the handler's prototype, from a
// Proxy handler's `get` trap, not callable, null; and a revoked proxy and a revoked
// handler. Each with the state after.
var r = [];
function t1() { return 't1'; }
var h1 = { get apply() { r.push('getter'); return function () { return 'got'; }; } };
r.push(new Proxy(t1, h1)());
var h2 = Object.create({ apply: function () { return 'proto'; } });
r.push(new Proxy(t1, h2)());
var h3 = new Proxy({}, { get: function (t, k) { r.push('get:' + String(k)); return k === 'apply' ? function () { return 'meta'; } : undefined; } });
r.push(new Proxy(t1, h3)());
try { new Proxy(t1, { apply: 1 })(); } catch (e) { r.push('noncallable:' + e.constructor.name); }
r.push(new Proxy(t1, { apply: null })());
var rv = Proxy.revocable(t1, {}); rv.revoke();
try { rv.proxy(); } catch (e) { r.push('revoked:' + e.constructor.name); }
var rh = Proxy.revocable({}, {}); rh.revoke();
try { new Proxy(t1, rh.proxy)(); } catch (e) { r.push('revoked-handler:' + e.constructor.name); }
try { new Proxy(t1, { get apply() { throw new Error('getter'); } })(); } catch (e) { r.push(e.message); }
r.push(new Proxy(t1, {})());
r.join()
// ---
// A Proxy nest at its ceiling and one past it, through the trap and through forwarding:
// the refusal happens at the same level and is not catchable.
function f(n) { var p = new Proxy(function () {}, { apply: function () { return f(n - 1); } }); return n > 0 ? p() : 'bottom'; }
var r = [];
try { r.push(f(100)); } catch (e) { r.push('caught'); }
r.push(f(118));
r.join()
// ---
function f(n) { var p = new Proxy(function () {}, { apply: function () { return f(n - 1); } }); return n > 0 ? p() : 'bottom'; }
try { f(119); } catch (e) { 'caught'; }
// ---
function f(n) { var p = new Proxy(function () {}, { apply: function () { return f(n - 1); } }); return n > 0 ? p() : 'bottom'; }
try { f(120); } catch (e) { 'caught'; }
// ---
function f(n) { return n > 0 ? fp(n - 1) : 'bottom'; }
var fp = new Proxy(f, {});
var r = [];
r.push(fp(117), fp(118));
r.join()
// ---
function f(n) { return n > 0 ? fp(n - 1) : 'bottom'; }
var fp = new Proxy(f, {});
fp(119)
// ---
function f(n) { return n > 0 ? fp(n - 1) : 'bottom'; }
var fp = new Proxy(new Proxy(f, {}), {});
var r = [fp(110)];
r.push(fp(111));
r.join()
// ---
function f(n) { return n > 0 ? fp(n - 1) : 'bottom'; }
var fp = new Proxy(new Proxy(f, {}), {});
fp(112)
// ---
// Throws from inside Proxy levels: caught by the callee, by an intermediate level, and
// by the outermost caller; then a nest that needs most of the budget, which completes
// only if every level gave its units back.
var log = [];
function f(n, at) { if (n === at) throw new Error('at' + n); return n > 0 ? g(n - 1, at) : 'ok'; }
var g = new Proxy(f, {});
var ht = new Proxy(function () {}, { apply: function (t, self, a) { return h(a[0], a[1], a[2]); } });
function h(n, at, catchAt) { if (n === catchAt) { try { return g(n, at); } catch (e) { return 'caught:' + e.message; } } return n > 0 ? ht(n - 1, at, catchAt) : g(0, at); }
log.push(ht(50, 10, 30), ht(50, 0, 49));
try { g(90, 3); } catch (e) { log.push(e.message); }
function deep(n) { return n > 0 ? new Proxy(deep, {})(n - 1) : n; }
log.push(deep(119));
log.join()
// ---
// flags: --eval-compiler
// Throws escaping in-place Proxy levels through every native that catches a guest throw:
// a Promise executor, `eval`, a generator body, an async function body, a JSON replacer
// and reviver, a sort comparator and an Array callback; then the budget probe.
var log = [];
function thrower(n) { return n > 0 ? tp(n - 1) : (function () { throw new TypeError('deep'); })(); }
var tp = new Proxy(function () {}, { apply: function (t, s, a) { return thrower(a[0]); } });
new Promise(function () { tp(40); }).catch(function (e) { log.push('promise:' + e.message); });
try { eval('tp(40)'); } catch (e) { log.push('eval:' + e.message); }
try { eval('(function () { return tp(40); })')(); } catch (e) { log.push('eval-fn:' + e.message); }
function* gn() { yield 1; tp(40); }
var it = gn(); it.next();
try { it.next(); } catch (e) { log.push('gen:' + e.message); }
async function an() { tp(40); }
an().catch(function (e) { log.push('async:' + e.message); });
try { JSON.stringify({ a: 1 }, function (k, v) { if (k === 'a') tp(40); return v; }); } catch (e) { log.push('replacer:' + e.message); }
try { JSON.parse('{"a":1}', function (k, v) { if (k === 'a') tp(40); return v; }); } catch (e) { log.push('reviver:' + e.message); }
try { [3, 1, 2].sort(function () { tp(40); }); } catch (e) { log.push('sort:' + e.message); }
try { [1].forEach(function () { tp(40); }); } catch (e) { log.push('forEach:' + e.message); }
function deep(n) { return n > 0 ? new Proxy(deep, {})(n - 1) : n; }
log.push(deep(119));
Promise.resolve().then(function () { log.push(deep(119)); });
log
// ---
// A value-stack overflow under Proxy levels halts where it did.
function deep() { return deep(); }
function f(n) { return n > 0 ? new Proxy(f, {})(n - 1) : deep(); }
f(40)
// ---
function deep() { return deep(); }
var p = new Proxy(function () {}, { apply: function (t, s, a) { return a[0] > 0 ? p(a[0] - 1) : deep(); } });
p(40)
// ---
// Value-stack overflows in recursions through a Proxy that pass k arguments a call,
// forwarded and through a trap that spreads them again: each reaches the budget at
// its own point of a call (the arguments pushed, the frame entered).
var a = []; for (var i = 0; i < 30; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(f, {});
f()
// ---
var a = []; for (var i = 0; i < 30; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(function () {}, { apply: function (t, s, args) { return f(...args); } });
f()
// ---
var a = []; for (var i = 0; i < 31; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(f, {});
f()
// ---
var a = []; for (var i = 0; i < 31; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(function () {}, { apply: function (t, s, args) { return f(...args); } });
f()
// ---
var a = []; for (var i = 0; i < 999; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(f, {});
f()
// ---
var a = []; for (var i = 0; i < 999; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(function () {}, { apply: function (t, s, args) { return f(...args); } });
f()
// ---
var a = []; for (var i = 0; i < 2000; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(f, {});
f()
// ---
var a = []; for (var i = 0; i < 2000; i++) a.push(i);
function f() { return fp(...a); }
var fp = new Proxy(function () {}, { apply: function (t, s, args) { return f(...args); } });
f()
// ---
// The render of a thrown deeply nested array is the same at any Proxy depth: the halt
// releases every level's units before the value is rendered.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { if (n === 0) throw nest(2040); return new Proxy(f, {})(n - 1); }
f(100)
// ---
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
var p = new Proxy(function () {}, { apply: function (t, s, a) { if (a[0] === 0) throw nest(2040); return p(a[0] - 1); } });
p(100)
// ---
// And of a completion value built after a Proxy nest returned.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { return n > 0 ? new Proxy(f, {})(n - 1) : 0; }
var p = new Proxy(function () {}, { apply: function (t, s, a) { return a[0] > 0 ? p(a[0] - 1) : 0; } });
f(110); p(110); nest(2040)
// ---
// A stack trace taken in a callee entered through a Proxy names the same frames.
function inner() { return new Error('t').stack; }
function mid() { return new Proxy(inner, {})(); }
var outer = new Proxy(function () {}, { apply: function trap() { return mid(); } });
outer()
// ---
// Proxy calls mixed with bound calls, getters, other Proxy traps, forEach and generators
// inside the nest, and proxies over bound functions (binding a Proxy is not modeled).
var log = [];
var obj = { get v() { return gp(3); } };
function g(n) { return n > 0 ? gp(n - 1) + 1 : [1].map(function () { return 0; })[0]; }
var gp = new Proxy(g, {});
var px = new Proxy({}, { get: function () { return gp(4); } });
function* gg() { yield gp(5); }
log.push(obj.v, px.anything, gg().next().value);
function mix(n) { return n > 0 ? (n % 4 === 0 ? obj.v + mixp(n - 1) : n % 4 === 1 ? px.z + mixb(n - 1) : n % 4 === 2 ? [n].map(function () { return mixp(n - 1); })[0] : mixt(n - 1)) : 0; }
var mixp = new Proxy(mix, {});
var mixb = new Proxy(mix.bind(null), {});
var mixt = new Proxy(function () {}, { apply: function (t, s, a) { return mix.bind(null, a[0])(); } });
log.push(mixp(30), mixb(30), mixt(30));
log.join()
// ---
// flags: --eval-compiler
// Traps and targets in another code segment (defined by `eval` or `Function`) still run in
// a nested loop; a nest through them, and a nest of in-place levels inside one.
var r = [];
var ev = eval('(function (a) { return "eval:" + a; })');
r.push(new Proxy(ev, {})('x'), new Proxy(Function('a', 'return "fn:" + a'), {})('y'));
r.push(new Proxy(function () {}, { apply: eval('(function (t, s, a) { return "evtrap:" + a[0]; })') })('z'));
var ef = eval('(function ef(n) { return n > 0 ? efp(n - 1) + 1 : 0; })');
var efp = new Proxy(ef, {});
r.push(efp(100));
function local(n) { return n > 0 ? localp(n - 1) + 1 : 0; }
var localp = new Proxy(local, {});
r.push(eval('localp(100)'), Function('return localp(100)')());
r.join()
// ---
// Throws from inside an explicit-stack walk (JSON.parse, JSON.stringify's toJSON, a
// reviver, `flat` over a throwing getter, a flatMap callback) caught below the Proxy
// frame that called the walk, 200 times: each pop of that frame inside the walk released
// its units, and the walk's restore must not charge them again.
var r = [];
var pb = new Proxy(function (x) { return JSON.parse(x); }, {});
for (var i = 0; i < 200; i++) { try { pb('{'); } catch (e) {} }
var sb = new Proxy(function () {}, { apply: function (t, s, a) { return JSON.stringify(a[0]); } });
var bad = { toJSON: function () { throw 1; } };
for (var i = 0; i < 200; i++) { try { sb(bad); } catch (e) {} }
var vb = new Proxy(function (x) { return JSON.parse(x, function (k, w) { if (k === 'a') throw 2; return w; }); }, {});
for (var i = 0; i < 200; i++) { try { vb('{"a":[1]}'); } catch (e) {} }
var flb = new Proxy(function (x) { return [x].flat(); }, {});
var hole = [1]; Object.defineProperty(hole, 0, { get: function () { throw 3; } });
for (var i = 0; i < 200; i++) { try { flb(hole); } catch (e) {} }
var fmb = new Proxy(function () {}, { apply: function () { return [[1]].flatMap(function () { throw 4; }); } });
for (var i = 0; i < 200; i++) { try { fmb(); } catch (e) {} }
function deep(n) { return n > 0 ? new Proxy(deep, {})(n - 1) : 'deep'; }
r.push(deep(119));
r.join()
// ---
// The same, then a completion value that needs nearly the whole render budget.
function f(n) {
  if (n > 0) return new Proxy(f, {})(n - 1);
  return [[1]].flatMap(function (x) { throw 1; });
}
try { f(100); } catch (e) {}
var a = [1]; for (var i = 0; i < 2040; i++) a = [a];
a
// ---
// Constructs are unchanged: through the trap, forwarding, and a mix with calls.
var r = [];
function C(a) { this.a = a; }
var pc = new Proxy(C, {});
r.push(new pc(1).a, new (new Proxy(C, { construct: function (t, a) { return { a: 'trap' + a[0] }; } }))(2).a);
function D(n) { if (!new.target) return n > 0 ? new Proxy(D, {})(n - 1) : 'call'; this.n = n; }
r.push(new Proxy(D, {})(20), new (new Proxy(D, {}))(3).n);
r.join()
