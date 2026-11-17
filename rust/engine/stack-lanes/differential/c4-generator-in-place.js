// C4: `RUN`'s call of a generator's `next`, `return` or `throw` resumes the body in its own
// dispatch loop, the driver's activation saved in a frame that holds the native's heavy unit
// with the 16 its nested `dispatch_at` charged, and that returns to the call as a generator:
// `YIELD` pushes the yielded result and `END` the `{value, done: true}` one, each with the
// meter check `RUN` made after the native returned. Every kind of resume.
var r = [];
function* g(a) { var x = yield a; var y = yield x * 2; return x + y; }
var it = g(1);
r.push(JSON.stringify(it.next('ignored')), JSON.stringify(it.next(5)), JSON.stringify(it.next(7)), JSON.stringify(it.next()), JSON.stringify(it.next()));
var early = g(2); r.push(JSON.stringify(early.return(3)), JSON.stringify(early.next()));
var thrown = g(2); try { thrown.throw(new Error('before')); } catch (e) { r.push('before:' + e.message); } r.push(JSON.stringify(thrown.next()));
function* f() { try { yield 1; yield 2; } finally { r.push('finally'); } }
var fi = f(); fi.next(); r.push(JSON.stringify(fi.return(9)), JSON.stringify(fi.next()));
function* h() { try { yield 1; } catch (e) { r.push('caught:' + e); yield 2; } return 3; }
var hi = h(); hi.next(); r.push(JSON.stringify(hi.throw('t')), JSON.stringify(hi.next()), JSON.stringify(hi.next()));
function* fy() { try { yield 1; } finally { yield 'from-finally'; r.push('after'); } }
var fyi = fy(); fyi.next(); r.push(JSON.stringify(fyi.return(4)), JSON.stringify(fyi.next()), JSON.stringify(fyi.next()));
function* self() { try { selfIt.next(); } catch (e) { r.push('running:' + e.constructor.name); } yield 1; }
var selfIt = self(); r.push(JSON.stringify(selfIt.next()));
try { g.prototype.next.call({}); } catch (e) { r.push('receiver:' + e.constructor.name); }
try { new (g(1).next)(); } catch (e) { r.push('new:' + e.constructor.name); }
var gi = g(10); r.push(JSON.stringify(gi.next.call(gi)), JSON.stringify(Reflect.apply(gi.next, gi, [3])), JSON.stringify(gi.next.bind(gi)(4)));
var proxied = new Proxy(g(20).next, {}); var pg = g(20); try { r.push(JSON.stringify(proxied.call(pg))); } catch (e) { r.push(e.constructor.name); }
function* thisy() { yield this.tag; yield arguments.length; } var ty = thisy.call({ tag: 'T' }, 1, 2); r.push(JSON.stringify(ty.next()), JSON.stringify(ty.next()));
r.join(' ')
// ---
// Delegation, iteration, spreads and destructuring, generators reading generators.
var r = [];
function* inner() { var x = yield 'i1'; yield 'i2:' + x; return 'iret'; }
function* outer() { var v = yield* inner(); yield 'o:' + v; }
var o = outer(); r.push(JSON.stringify(o.next()), JSON.stringify(o.next('X')), JSON.stringify(o.next()), JSON.stringify(o.next()));
function* count(n) { for (var i = 0; i < n; i++) yield i; }
r.push([...count(4)].join(), Array.from(count(3)).join());
var [a, b, ...rest] = count(5); r.push(a, b, rest.join());
for (var v of count(10)) { if (v === 2) break; } r.push('broke');
var sum = 0; for (var v of count(5)) for (var w of count(v)) sum += w; r.push(sum);
function* fib() { var p = 0, q = 1; while (true) { yield p; var t = p; p = q; q = t + q; } }
var fi = fib(), fs = []; for (var k = 0; k < 20; k++) fs.push(fi.next().value); r.push(fs.join('|'));
function* zip(x, y) { var ix = x[Symbol.iterator](), iy = y[Symbol.iterator](); while (true) { var a1 = ix.next(), b1 = iy.next(); if (a1.done || b1.done) return; yield a1.value + b1.value; } }
r.push([...zip(count(3), count(5))].join());
function* reader(src) { var s = src(); var n; while (!(n = s.next()).done) yield n.value * 10; }
r.push([...reader(function () { return count(4); })].join());
r.join(' ')
// ---
// flags: --eval-compiler
// Generators defined by `eval` and `Function` (another segment) resume in their own loop,
// beside ones that resume in place; `with` and direct `eval` inside generator bodies.
var r = [];
var eg = eval('(function* (a) { var b = yield a + 1; yield b * 3; })');
var ei = eg(1); r.push(JSON.stringify(ei.next()), JSON.stringify(ei.next(2)), JSON.stringify(ei.next()));
var fg = Function('return function* () { yield "fn"; }')(); r.push(JSON.stringify(fg().next()));
function* local(n) { var v = yield n; yield eval('v + n'); with ({ w: 'W' }) { yield w + n; } }
var li = local(5); r.push(JSON.stringify(li.next()), JSON.stringify(li.next(2)), JSON.stringify(li.next()), JSON.stringify(li.next()));
function* mixed(n) { if (n > 0) { var e = eval('(function* () { yield mixed(n - 1).next().value; })')(); yield e.next().value + 1; } else yield 0; }
r.push(mixed(30).next().value);
r.push(eval('local(1).next().value'), Function('return local(2).next().value')());
r.join(' ')
// ---
// A generator nest at its ceiling and one past it: the refusal happens at the same level.
function f(n) { if (n <= 0) return 'bottom'; var r; function* g() { r = f(n - 1); } g().next(); return r; }
var out = [];
try { out.push(f(40)); } catch (e) { out.push('caught'); }
out.push(f(63));
out.join()
// ---
function f(n) { if (n <= 0) return 'bottom'; var r; function* g() { r = f(n - 1); } g().next(); return r; }
try { f(64); } catch (e) { 'caught'; }
// ---
function f(n) { if (n <= 0) return 'bottom'; var r; function* g() { r = f(n - 1); } g().next(); return r; }
try { f(65); } catch (e) { 'caught'; }
// ---
// Nests through yields, returns and throws, and generators mixed with getter, setter, bound,
// Proxy and `Reflect` levels.
var res = [];
function viaYield(n) { function* g() { yield n > 0 ? viaYield(n - 1) + 1 : 0; } return g().next().value; }
res.push(viaYield(60));
function viaReturn(n) { function* g() { return n > 0 ? viaReturn(n - 1) + 1 : 0; } return g().next().value; }
res.push(viaReturn(60));
function viaThrow(n) { function* g() { try { yield 1; } catch (e) { yield n > 0 ? viaThrow(n - 1) + 1 : 0; } } var it = g(); it.next(); return it.throw('x').value; }
res.push(viaThrow(60));
function viaReturnCall(n) { function* g() { try { yield 1; } finally { res.length; } } var it = g(); it.next(); return n > 0 ? it.return(viaReturnCall(n - 1) + 1).value : it.return(0).value; }
res.push(viaReturnCall(50));
function mix(n) { if (n <= 0) return 0; switch (n % 6) { case 0: function* g() { yield mix(n - 1) + 1; } return g().next().value; case 1: return { get v() { return mix(n - 1) + 1; } }.v; case 2: var r; ({ set v(x) { r = mix(n - 1) + 1; } }).v = 0; return r; case 3: return mix.bind(null, n - 1)() + 1; case 4: return new Proxy(mix, {})(n - 1) + 1; default: return Reflect.apply(mix, null, [n - 1]) + 1; } }
res.push(mix(60));
res.join()
// ---
// Throws from inside generator levels: caught by the body, by an intermediate level, and by
// the outermost caller; the generator is done afterwards; then a nest that needs most of the
// budget.
var log = [];
function f(n, at) { if (n === at) throw new Error('at' + n); var r; function* g() { r = f(n - 1, at); } g().next(); return r === undefined ? 'ok' : r; }
function h(n, at, catchAt) { if (n === catchAt) { try { return f(n, at); } catch (e) { return 'caught:' + e.message; } } var r; function* g() { r = n > 0 ? h(n - 1, at, catchAt) : f(0, at); } g().next(); return r; }
log.push(h(40, 10, 30), h(40, 0, 39));
try { f(50, 3); } catch (e) { log.push(e.message); }
function* boom() { yield 1; throw new Error('boom'); }
var bi = boom(); bi.next(); try { bi.next(); } catch (e) { log.push(e.message, JSON.stringify(bi.next())); }
function* catcher() { try { yield 1; } catch (e) { return 'kept:' + e; } }
var ci = catcher(); ci.next(); log.push(JSON.stringify(ci.throw('z')), JSON.stringify(ci.next()));
function deep(n) { if (n <= 0) return 0; var r; function* g() { r = deep(n - 1); } g().next(); return r; }
log.push(deep(63));
log.join()
// ---
// flags: --eval-compiler
// Throws escaping generator levels through the natives and drivers that catch a guest throw
// and through callbacks of natives that do not; then the budget probe, also from a job.
var log = [];
function thrower(n) { function* g() { if (n > 0) thrower(n - 1); else (function () { throw new TypeError('deep'); })(); } g().next(); }
new Promise(function () { thrower(20); }).catch(function (e) { log.push('promise:' + e.message); });
try { eval('thrower(20)'); } catch (e) { log.push('eval:' + e.message); }
function* gn() { yield 1; thrower(20); }
var it = gn(); it.next();
try { it.next(); } catch (e) { log.push('gen:' + e.message); }
async function an() { thrower(20); }
an().catch(function (e) { log.push('async:' + e.message); });
try { JSON.stringify({ a: 1 }, function (k, v) { if (k === 'a') thrower(20); return v; }); } catch (e) { log.push('replacer:' + e.message); }
try { [3, 1, 2].sort(function () { thrower(20); }); } catch (e) { log.push('sort:' + e.message); }
try { [1].forEach(function () { thrower(20); }); } catch (e) { log.push('forEach:' + e.message); }
try { Reflect.apply(thrower, null, [20]); } catch (e) { log.push('Reflect:' + e.message); }
try { for (var x of (function* () { thrower(20); yield 1; })()) {} } catch (e) { log.push('for-of:' + e.message); }
function deep(n) { if (n <= 0) return 0; var r; function* g() { r = deep(n - 1); } g().next(); return r; }
log.push(deep(63));
Promise.resolve().then(function () { log.push(deep(63)); });
log
// ---
// A value-stack overflow under generator levels halts where it did.
function deep() { return deep(); }
function f(n) { function* g() { if (n > 0) f(n - 1); else deep(); } g().next(); }
f(30)
// ---
var a = []; for (var i = 0; i < 40; i++) a.push(i);
function* g() { h(...a); }
function h() { g().next(); }
h()
// ---
function deep(n, p, q) { var l1, l2, l3, l4; return deep(n + 1, p, q); }
function f(n) { function* g(v) { var x = yield; if (n > 0) f(n - 1); else deep(0, x, v); } var it = g(n); it.next(); it.next(n); }
f(25)
// ---
// Throws from inside explicit-stack walks caught below a generator frame, 200 times; then
// the budget probe.
var r = [];
var hole = [1]; Object.defineProperty(hole, 0, { get: function () { throw 3; } });
function* walks(k) {
  if (k === 'p') JSON.parse('{');
  if (k === 's') JSON.stringify({ toJSON: function () { throw 1; } });
  if (k === 'v') JSON.parse('{"a":[1]}', function (key, x) { if (key === 'a') throw 2; return x; });
  if (k === 'fl') [hole].flat();
  if (k === 'fm') [[1]].flatMap(function () { throw 4; });
  yield k;
}
for (var k of ['p', 's', 'v', 'fl', 'fm']) for (var i = 0; i < 200; i++) { try { walks(k).next(); } catch (e) {} }
function deep(n) { if (n <= 0) return 'deep'; var v; function* g() { v = deep(n - 1); } g().next(); return v; }
r.push(deep(63));
r.join()
// ---
// The render of a thrown deeply nested array is the same at any generator depth, and of a
// completion value built after a generator nest returned.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { function* g() { if (n === 0) throw nest(2040); f(n - 1); } g().next(); }
f(50)
// ---
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { function* g() { if (n > 0) f(n - 1); } g().next(); }
f(60); nest(2040)
// ---
// A stack trace taken in a generator names the same frames.
var trace;
function inner() { trace = new Error('t').stack; }
function* mid() { inner(); yield 1; }
function outer() { function* top() { mid().next(); yield 2; } top().next(); return trace; }
outer()
// ---
// Meter-heavy generator loops: 60,000 short resumes, among which the loop's meter checks
// fall, through every kind of resume.
function* c() { var n = 0; while (true) { try { n += (yield n) || 1; } catch (e) { n += 2; } } }
var it = c(); it.next();
var s = 0;
for (var i = 0; i < 20000; i++) s += it.next(1).value;
for (var i = 0; i < 20000; i++) s += it.throw(0).value;
for (var i = 0; i < 20000; i++) { var g2 = c(); g2.next(); s += g2.return(i).value; }
s
// ---
// A generator that `resume_generator` still runs in a nested loop, inside a body resumed in
// place, throws past both to a handler below them: each generator is completed, the inner
// by its own driver and the outer by its frame, whichever way the inner was resumed.
var out = [];
function* boom() { throw new Error('boom'); }
var resumers = [
  function (g) { return Reflect.apply(g.next, g, []); },
  function (g) { return g.next.call(g); },
  function (g) { return g.next.apply(g, []); },
  function (g) { return g.next.bind(g)(); },
  function (g) { return new Proxy(g.next, {}).call(g); },
  function (g) { return Array.from(g); },
];
for (var i = 0; i < resumers.length; i++) {
  var inner = boom();
  var outer = (function* () { resumers[i](inner); yield 1; })();
  try { outer.next(); } catch (e) { out.push(String(e)); }
  out.push(JSON.stringify(outer.next()), JSON.stringify(inner.next()));
}
out.join('|')
// ---
// The same throw caught by a `finally` in an outer function, by a getter's caller and by an
// outer generator resumed in place, with an old-path generator resumed in place in turn
// inside the inner one.
var out = [];
function* boom() { throw 'b'; }
function* deepest() { yield 0; throw 'd'; }
function catcher(f) { try { f(); } finally { out.push('fin'); } }
var a = boom(), outerA = (function* () { a.next.call(a); yield 1; })();
try { catcher(function () { outerA.next(); }); } catch (e) { out.push('c:' + e); }
out.push(JSON.stringify(outerA.next()));
var b = boom(), outerB = (function* () { yield Reflect.apply(b.next, b, []); })();
var o = { get v() { return outerB.next(); } };
try { o.v; } catch (e) { out.push('g:' + e); }
out.push(JSON.stringify(outerB.next()));
var d = deepest(); d.next();
var mid = (function* () { yield d.next(); })();
var top = (function* () { try { mid.next.call(mid); } catch (e) { out.push('t:' + e); } yield 2; })();
out.push(JSON.stringify(top.next()), JSON.stringify(top.next()), JSON.stringify(mid.next()), JSON.stringify(d.next()));
out.join('|')
// ---
// flags: --eval-compiler
// An eval-defined generator resumes through `resume_generator` even from a plain call, a
// for-of and a `yield*`; its throw past a body resumed in place completes both.
var out = [];
var bodies = [
  "(function*(){ throw new Error('x'); })",
  "(function*(){ yield 0; throw new Error('y'); })",
];
for (var i = 0; i < bodies.length; i++) {
  var g2 = (0, eval)(bodies[i])();
  var g1 = (function* () { for (var x of g2) {} yield 1; })();
  try { g1.next(); } catch (e) { out.push(String(e)); }
  out.push(JSON.stringify(g1.next()));
  var g3 = (0, eval)(bodies[i])();
  var g4 = (function* () { try { yield* g3; } finally { out.push('f'); } })();
  try { g4.next(); g4.next(); } catch (e) { out.push(String(e)); }
  out.push(JSON.stringify(g4.next()));
}
var g5 = Function("return function*(){ throw 7; }")()();
var g6 = (function* () { g5.next(); yield 1; })();
try { g6.next(); } catch (e) { out.push(e); }
out.push(JSON.stringify(g6.next()));
out.join('|')
