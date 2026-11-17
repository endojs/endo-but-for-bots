// flags: --eval-compiler
// A1 follow-up: `eval` dispatched out of line on its own, not through the union of the
// remaining natives. Direct and indirect, strict and sloppy, a class field initializer, a
// non-string input, no input, a construct, a syntax error, and the call paths around it.
function s(v) { try { return typeof v === 'symbol' ? v.toString() : (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v)); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var x = 'global';
out.push(t(function () { var x = 'local'; return eval('x'); }));
out.push(t(function () { var x = 'local'; return (0, eval)('x'); }));
out.push(t(function () { var x = 'local'; var e = eval; return e('x'); }));
out.push(t(function () { 'use strict'; eval('var leaked = 1'); return typeof leaked; }));
out.push(t(function () { eval('var kept = 2'); return typeof kept; }));
out.push(t(function () { 'use strict'; return eval('undeclared1 = 1'); }));
out.push(t(function () { 'use strict'; return (0, eval)('undeclared2 = 2'); }));
out.push(t(function () { return (0, eval)('"use strict"; undeclared3 = 3'); }));
out.push(t(function () { return [eval(42), eval({ a: 1 }), eval(), eval(undefined), eval(null), eval(true), eval('1;', 'ignored')]; }));
out.push(t(function () { var o = new String('1 + 1'); return eval(o) === o; }));
out.push(t(function () { return new eval('1'); }));
out.push(t(function () { return new eval(); }));
out.push(t(function () { return Reflect.construct(eval, ['1']); }));
out.push(t(function () { return eval('('); }));
out.push(t(function () { return eval('}'); }));
out.push(t(function () { return eval('throw new RangeError("inside")'); }));
out.push(t(function () { return [eval.call(null, '1 + 2'), eval.apply(null, ['3 * 4']), Reflect.apply(eval, null, ['5 - 1']), eval.bind(null)('6')]; }));
out.push(t(function () { return [eval('this') === globalThis, (0, eval)('this') === globalThis]; }));
out.push(t(function () { var o = { m: function () { return eval('this'); } }; return o.m() === o; }));
out.push(t(function () { class C { f = eval('this'); g = eval('typeof new.target'); } var c = new C(); return [c.f === c, c.g]; }));
out.push(t(function () { class C { f = eval('arguments'); } return new C().f; }));
out.push(t(function () { function g() { return eval('arguments.length'); } return g(1, 2, 3); }));
out.push(t(function () { return eval('eval("eval(\'1 + 1\')")'); }));
out.push(t(function () { return eval('function hoisted() { return "h"; } hoisted()'); }));
out.push(t(function () { return eval('let l = 7; l') + typeof l; }));
out.push(t(function () { return [eval.name, eval.length, typeof eval]; }));
out.push(t(function () { var p = new Proxy(eval, {}); return p('1 + 9'); }));
out.join('\n')
// ---
// flags: --eval-compiler
// The same `eval` call recursing direct and indirect, each through a dozen levels, a throw
// unwinding through every level, and a nest that ends in a syntax error at the bottom.
var r = [];
function d(n) { if (n > 0) return eval('d(n - 1) + 1'); return 0; }
function i(n) { if (n > 0) return (0, eval)('i(' + (n - 1) + ') + 1'); return 0; }
function th(n) { if (n > 0) return eval('th(n - 1)'); throw new TypeError('bottom'); }
function sx(n) { if (n > 0) return eval('sx(n - 1)'); return eval('1 +'); }
r.push(d(12), i(12));
try { th(12); } catch (e) { r.push(e.name + ':' + e.message); }
try { sx(12); } catch (e) { r.push(e.name); }
r.join(' ')
// ---
// A1 follow-up: `%IteratorHelperPrototype%.next` dispatched out of line on its own, with the
// `flatMap` step and the `map`/`filter`/`flatMap` callback call out of line of it. Every kind
// of helper, every way a step ends, and the receivers it refuses.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var log = [];
function src(n) { var i = 0; return { __proto__: Iterator.prototype, next: function () { log.push('n' + i); return i < n ? { value: i++, done: false } : { value: 'end', done: true }; }, return: function () { log.push('ret'); return {}; } }; }
function drain(it) { var a = []; for (var k = 0; k < 20; k++) { var r = it.next(); a.push(r.done ? 'done' : r.value); if (r.done) break; } return a.join(','); }
out.push(t(function () { log = []; return [drain(src(5).take(3)), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(5).take(0)), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(2).take(Infinity)), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(5).drop(2)), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(3).drop(5)), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(4).map(function (v, k) { return v * 10 + k; })), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(6).filter(function (v, k) { return (v + k) % 4 === 0; })), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(3).flatMap(function (v, k) { return [v, k, v + k]; })), log.join()]; }));
out.push(t(function () { log = []; return [drain(src(3).flatMap(function (v) { return v === 1 ? [] : src(v); })), log.join()]; }));
out.push(t(function () { return drain(src(3).flatMap(function (v) { return 'ab'; })); }));
out.push(t(function () { return drain(src(3).flatMap(function (v) { return new String('ab'); })); }));
out.push(t(function () { return drain(src(3).flatMap(function (v) { return { next: function () { return { done: true }; } }; })); }));
out.push(t(function () { log = []; var it = src(5).map(function (v) { if (v === 2) throw new RangeError('map ' + v); return v; }); return [drain(it), log.join()]; }));
out.push(t(function () { log = []; var it = src(5).map(function (v) { if (v === 2) throw new RangeError('map ' + v); return v; }); it.next(); it.next(); try { it.next(); } catch (e) { log.push(e.message); } return [JSON.stringify(it.next()), log.join()]; }));
out.push(t(function () { log = []; var it = src(5).filter(function (v) { if (v === 1) throw new EvalError('filter'); return true; }); it.next(); try { it.next(); } catch (e) { log.push(e.name); } return log.join(); }));
out.push(t(function () { log = []; var it = src(5).flatMap(function (v) { if (v === 1) throw new SyntaxError('flat'); return [v]; }); it.next(); try { it.next(); } catch (e) { log.push(e.name); } return log.join(); }));
out.push(t(function () { log = []; var inner = { __proto__: Iterator.prototype, next: function () { throw new URIError('inner'); }, return: function () { log.push('iret'); return {}; } }; var it = src(5).flatMap(function () { return inner; }); try { it.next(); } catch (e) { log.push(e.name); } return log.join(); }));
out.push(t(function () { var bad = { __proto__: Iterator.prototype, next: function () { throw new TypeError('under'); }, return: function () { log.push('never'); } }; log = []; var it = bad.take(2); try { it.next(); } catch (e) { log.push(e.message); } return [JSON.stringify(it.next()), log.join()]; }));
out.push(t(function () { var prim = { __proto__: Iterator.prototype, next: function () { return 7; } }; return prim.map(function (v) { return v; }).next(); }));
out.push(t(function () { var g = { __proto__: Iterator.prototype, next: function () { return { get done() { throw new RangeError('done getter'); } }; } }; return g.drop(0).next(); }));
out.push(t(function () { var g = { __proto__: Iterator.prototype, next: function () { return { done: false, get value() { throw new RangeError('value getter'); } }; } }; return g.filter(function () { return true; }).next(); }));
out.push(t(function () { var g = { __proto__: Iterator.prototype, next: 5 }; return g.take(1).next(); }));
out.push(t(function () { var it; it = src(5).map(function (v) { return it.next(); }); return it.next(); }));
out.push(t(function () { var it; it = src(5).filter(function (v) { try { it.next(); } catch (e) { return e.message; } }); return it.next(); }));
out.push(t(function () { var it = src(1).map(function (v) { return v; }); return [JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next())]; }));
out.push(t(function () { var it = src(3).take(2); it.return(); return JSON.stringify(it.next()); }));
var next = Object.getPrototypeOf(src(1).take(1)).next;
out.push(t(function () { return next.call({}); }));
out.push(t(function () { return next.call(5); }));
out.push(t(function () { return next.call([1].values()); }));
out.push(t(function () { return next.call(new Proxy(src(1).take(1), {})); }));
out.push(t(function () { return [next.call(src(2).take(1)).value, Reflect.apply(next, src(2).drop(1), []).value, next.bind(src(2).map(function (v) { return -v; }))().value]; }));
out.push(t(function () { return new next(); }));
out.push(t(function () { return [[1, 2, 3].values().take(2).map(function (v) { return v * v; }).toArray(), [1, 2, 3, 4].values().drop(1).filter(function (v) { return v % 2; }).toArray()]; }));
out.push(t(function () { return Array.from(new Set([1, 2]).values().flatMap(function (v) { return new Map([[v, -v]]).entries(); })); }));
out.push(t(function () { function* gen() { yield 1; yield 2; yield 3; } return [...gen().map(function (v) { return v + 1; }).take(2)]; }));
out.push(t(function () { return Iterator.from({ next: function () { return { value: 1, done: false }; } }).take(3).toArray(); }));
out.join('\n')
// ---
// Helper chains through every lazy kind up to the native ceiling, each level re-entering
// through the next one's `next`.
var r = [];
function chain(n, wrap) { var it = [1, 2, 3].values(); for (var i = 0; i < n; i++) it = wrap(it); return it; }
var kinds = [
  ['drop', function (it) { return it.drop(0); }],
  ['filter', function (it) { return it.filter(function () { return true; }); }],
  ['flatMap', function (it) { return it.flatMap(function (v) { return [v]; }); }],
  ['take', function (it) { return it.take(5); }],
  ['map', function (it) { return it.map(function (v) { return v; }); }],
];
var depths = [1, 2, 63, 125, 126];
for (var k = 0; k < kinds.length; k++) {
  for (var j = 0; j < depths.length; j++) {
    r.push(kinds[k][0] + depths[j] + ':' + JSON.stringify(chain(depths[j], kinds[k][1]).next()));
  }
}
r.join(' ')
// ---
// One level past the ceiling, for the kinds the corpus has no family for: the refusal lands
// at the same level.
var it = [1, 2, 3].values(); for (var i = 0; i < 127; i++) it = it.drop(0); it.next().value
// ---
var it = [1, 2, 3].values(); for (var i = 0; i < 127; i++) it = it.filter(function () { return true; }); it.next().value
// ---
var it = [1, 2, 3].values(); for (var i = 0; i < 127; i++) it = it.flatMap(function (v) { return [v]; }); it.next().value
// ---
// A1 follow-up: `%AsyncGeneratorPrototype%.next`, `return` and `throw` dispatched out of line
// on their own. Every request kind against a suspended-start, suspended-yield, executing and
// completed generator, queued requests, and the receivers they reject.
var r = [];
function rec(tag) { return function (v) { r.push(tag + ':' + (v && typeof v === 'object' && 'done' in v ? JSON.stringify(v) : String(v && v.message || v))); }; }
async function* ag(a) { try { var b = yield a; r.push('got:' + b); var c = yield await b + 1; return c * 2; } finally { r.push('finally:' + a); } }
var g1 = ag(1);
g1.next('ignored').then(rec('g1n1'));
g1.next(5).then(rec('g1n2'));
g1.next(7).then(rec('g1n3'));
g1.next().then(rec('g1n4'));
var g2 = ag(2);
g2.return(3).then(rec('g2r'));
g2.next().then(rec('g2n'));
var g3 = ag(3);
g3.throw(new Error('early')).then(rec('g3t'), rec('g3t-rej'));
g3.next().then(rec('g3n'));
var g4 = ag(4);
g4.next().then(rec('g4n'));
g4.throw(new RangeError('mid')).then(rec('g4t'), rec('g4t-rej'));
g4.next().then(rec('g4n2'));
var g5 = ag(5);
g5.next().then(rec('g5n'));
g5.return(Promise.resolve('awaited')).then(rec('g5r'));
async function* catcher() { while (true) { try { yield 'ready'; } catch (e) { r.push('caught:' + e); } } }
var g6 = catcher();
g6.next().then(rec('g6n'));
g6.throw('x1').then(rec('g6t1'));
g6.throw('x2').then(rec('g6t2'));
g6.return('stop').then(rec('g6r'));
async function* selfish() { r.push('self:' + typeof g7.next().then); yield 1; }
var g7 = selfish();
g7.next().then(rec('g7n'));
var proto = Object.getPrototypeOf(ag.prototype);
proto.next.call({}).then(rec('brand-n'), rec('brand-n-rej'));
proto.return.call(5).then(rec('brand-r'), rec('brand-r-rej'));
proto.throw.call(ag(0)[Symbol.asyncIterator]).then(rec('brand-t'), rec('brand-t-rej'));
proto.next.call((function* () {})()).then(rec('brand-sync'), rec('brand-sync-rej'));
try { new proto.next(); } catch (e) { r.push('new:' + e.name); }
Reflect.apply(proto.next, ag(8), [1]).then(rec('reflect'));
proto.next.bind(ag(9))().then(rec('bound'));
(async function () { var acc = []; for await (var v of ag(10)) acc.push(v); r.push('forawait:' + acc.join()); })();
(async function () { var it = ag(11); var a = await it.next(); var b = await it.return('early'); r.push('awaited:' + JSON.stringify([a, b])); })();
r
// ---
// Async generators nested through `next`, each level's body calling the next level's, up to
// the native ceiling, and chains of `return` and `throw` requests beside them.
var r = [];
function nest(depth) { async function* g(n) { if (n > 0) g(n - 1).next(); yield n; } return g(depth).next(); }
async function* closer(n) { try { yield n; } finally { if (n > 0) { var it = closer(n - 1); it.next(); it.return(n).then(function (v) { r.push('cl' + JSON.stringify(v)); }); } } }
async function* thrower(n) { try { yield n; } catch (e) { if (n > 0) { var it = thrower(n - 1); it.next(); it.throw(e + n).then(function (v) { r.push('th' + JSON.stringify(v)); }); } } }
var depths = [1, 2, 31, 61, 62];
for (var j = 0; j < depths.length; j++) nest(depths[j]).then(function (v) { r.push('n' + JSON.stringify(v)); });
var c = closer(40); c.next(); c.return('x').then(function (v) { r.push('c' + JSON.stringify(v)); });
var h = thrower(40); h.next(); h.throw('y').then(function (v) { r.push('t' + JSON.stringify(v)); });
r
