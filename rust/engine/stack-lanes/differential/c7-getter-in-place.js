// C7: `GET_PROPERTY` of an ordinary object whose walk reaches a getter that is a user
// function over the same buffer enters the getter's frame in its own dispatch loop, the
// frame holding `[[Get]]`'s light unit with the 16 its nested `dispatch_at` charged, and
// returning as a getter: its result pushed as the property's value, with no meter check.
// Every kind of getter, holder and receiver.
var r = [];
var o = { get a() { return 'a:' + (this === o); }, get b() { return this; } };
r.push(o.a, o.b === o);
var child = Object.create(o); r.push(child.a, child.b === child);
var deepChild = Object.create(Object.create(Object.create(o))); r.push(deepChild.a);
class K { get k() { return 'k:' + this.constructor.name; } static get s() { return 's:' + this.name; } }
class L extends K { get k() { return 'L>' + super.k; } }
r.push(new K().k, new L().k, K.s, L.s);
var d = {}; Object.defineProperty(d, 'arrow', { get: () => typeof this });
Object.defineProperty(d, 'gen', { get: function* () { yield 1; yield 2; } });
Object.defineProperty(d, 'async', { get: async function () { return 3; } });
Object.defineProperty(d, 'agen', { get: async function* () { yield 4; } });
Object.defineProperty(d, 'bound', { get: function () { return this.tag; }.bind({ tag: 'bound' }) });
Object.defineProperty(d, 'native', { get: Array.prototype.join });
Object.defineProperty(d, 'proxied', { get: new Proxy(function () { return 'proxied'; }, {}) });
Object.defineProperty(d, 'cls', { get: K });
Object.defineProperty(d, 'undef', { get: undefined, set: function () {} });
r.push(d.arrow, [...d.gen].join(), d.async instanceof Promise, typeof d.agen.next, d.bound, d.native, d.proxied, d.undef);
try { d.cls; } catch (e) { r.push('class-getter:' + e.constructor.name); }
var arr = [1, 2]; Object.defineProperty(arr, 'g', { get: function () { return this.length; } }); r.push(arr.g, arr.length, arr[1]);
var fn = function f() {}; Object.defineProperty(fn, 'g', { get: function () { return this.name; } }); r.push(fn.g, fn.name, fn.length);
var ta = new Uint8Array(2); Object.defineProperty(ta, 'g', { get: function () { return this.length; } }); r.push(ta.g, ta[0]);
var str = new String('ab'); Object.defineProperty(str, 'g', { get: function () { return this.length; } }); r.push(str.g, str[1], str.length);
var m = new Map([[1, 2]]); r.push(m.size);
var px = new Proxy({ get v() { return 'pv'; } }, {}); r.push(px.v, Object.create(px).v);
var trapped = Object.create(new Proxy({}, { get: function (t, k) { return 'trap:' + String(k); } })); r.push(trapped.zz);
var meth = { get m() { var self = this; return function (x) { return [self === meth, x].join(); }; } };
r.push(meth.m(5), meth.m.call(null, 6));
var cnt = 0; var counter = { get c() { return ++cnt; } }; r.push(counter.c + counter.c * 10, cnt);
r.push(`${o.a}|${counter.c}`, [counter.c, counter.c].join(), counter.c ? counter.c : -1);
try { ({ get t() { throw new Error('thrown'); } }).t; } catch (e) { r.push(e.message); }
var args = { get n() { return arguments.length; } }; r.push(args.n);
var sloppy = { get t() { return typeof this; } }; r.push(sloppy.t, Object.getOwnPropertyDescriptor(sloppy, 't').get.call(5));
r.join(' ')
// ---
// flags: --eval-compiler
// Primitive receivers, `with`, eval-defined getters and an inherited getter on a
// primitive's prototype take the paths they took.
var r = [];
Object.defineProperty(Object.prototype, 'og', { get: function () { return typeof this; }, configurable: true });
r.push((5).og, 'x'.og, true.og, ({}).og, [].og, (function () {}).og);
delete Object.prototype.og;
var ev = eval('({ get e() { return "eval:" + typeof this; } })'); r.push(ev.e);
var o = { get w() { return 'with'; } };
with (o) { r.push(w); }
var nest = eval('(function nest(n) { var q = { get g() { return n > 0 ? nest(n - 1) + 1 : 0; } }; return q.g; })');
r.push(nest(50));
function local(n) { var q = { get g() { return n > 0 ? local(n - 1) + 1 : 0; } }; return q.g; }
r.push(eval('local(50)'), Function('return local(50)')());
r.join()
// ---
// A getter nest at its ceiling and one past it: the refusal happens at the same level.
function f(n) { var o = { get x() { return n > 0 ? f(n - 1) : 'bottom'; } }; return o.x; }
var r = [];
try { r.push(f(100)); } catch (e) { r.push('caught'); }
r.push(f(118));
r.join()
// ---
function f(n) { var o = { get x() { return n > 0 ? f(n - 1) : 'bottom'; } }; return o.x; }
try { f(119); } catch (e) { 'caught'; }
// ---
function f(n) { var o = { get x() { return n > 0 ? f(n - 1) : 'bottom'; } }; return o.x; }
try { f(120); } catch (e) { 'caught'; }
// ---
// Inherited getters at depth, a class getter nest, and getters mixed with bound, Proxy and
// Reflect levels.
var proto = { get x() { return this.n > 0 ? mk(this.n - 1).x : 'bottom'; } };
function mk(n) { var o = Object.create(Object.create(proto)); o.n = n; return o; }
var r = [mk(100).x];
class G { constructor(n) { this.n = n; } get x() { return this.n > 0 ? new G(this.n - 1).x : 'g'; } }
r.push(new G(110).x);
function mix(n) { if (n <= 0) return 0; switch (n % 4) { case 0: return { get v() { return mix(n - 1) + 1; } }.v; case 1: return mix.bind(null, n - 1)() + 1; case 2: return new Proxy(mix, {})(n - 1) + 1; default: return Reflect.apply(mix, null, [n - 1]) + 1; } }
r.push(mix(80));
r.join()
// ---
// Throws from inside getter levels: caught by the getter, by an intermediate level, and by
// the outermost caller; then a nest that needs most of the budget.
var log = [];
function f(n, at) { if (n === at) throw new Error('at' + n); return { get x() { return n > 0 ? f(n - 1, at) : 'ok'; } }.x; }
function h(n, at, catchAt) { if (n === catchAt) { try { return f(n, at); } catch (e) { return 'caught:' + e.message; } } return { get x() { return n > 0 ? h(n - 1, at, catchAt) : f(0, at); } }.x; }
log.push(h(60, 10, 40), h(60, 0, 59));
try { f(90, 3); } catch (e) { log.push(e.message); }
function deep(n) { return { get x() { return n > 0 ? deep(n - 1) : n; } }.x; }
log.push(deep(118));
log.join()
// ---
// flags: --eval-compiler
// Throws escaping getter levels through the natives and drivers that catch a guest throw
// (a promise executor, `eval`, a generator, an async function) and through callbacks of
// natives that do not; then the budget probe, also from a job.
var log = [];
function thrower(n) { return { get x() { return n > 0 ? thrower(n - 1) : (function () { throw new TypeError('deep'); })(); } }.x; }
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
function deep(n) { return { get x() { return n > 0 ? deep(n - 1) : n; } }.x; }
log.push(deep(118));
Promise.resolve().then(function () { log.push(deep(118)); });
log
// ---
// A value-stack overflow under getter levels halts where it did.
function deep() { return deep(); }
function f(n) { return { get x() { return n > 0 ? f(n - 1) : deep(); } }.x; }
f(40)
// ---
var a = []; for (var i = 0; i < 40; i++) a.push(i);
function g() { return { get x() { return h(...a); } }.x; }
function h() { return g(); }
g()
// ---
// Throws from inside explicit-stack walks caught below a getter frame, 200 times; then the
// budget probe.
var r = [];
var hole = [1]; Object.defineProperty(hole, 0, { get: function () { throw 3; } });
var w = {
  get p() { return JSON.parse('{'); },
  get s() { return JSON.stringify({ toJSON: function () { throw 1; } }); },
  get v() { return JSON.parse('{"a":[1]}', function (k, x) { if (k === 'a') throw 2; return x; }); },
  get fl() { return [hole].flat(); },
  get fm() { return [[1]].flatMap(function () { throw 4; }); },
};
for (var k of ['p', 's', 'v', 'fl', 'fm']) for (var i = 0; i < 200; i++) { try { w[k]; } catch (e) {} }
for (var i = 0; i < 200; i++) { try { w.p; } catch (e) {} try { w.fm; } catch (e) {} }
function deep(n) { return { get x() { return n > 0 ? deep(n - 1) : 'deep'; } }.x; }
r.push(deep(118));
r.join()
// ---
// The render of a thrown deeply nested array is the same at any getter depth, and of a
// completion value built after a getter nest returned.
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { return { get x() { if (n === 0) throw nest(2040); return f(n - 1); } }.x; }
f(100)
// ---
function nest(d) { var a = [1]; for (var i = 0; i < d; i++) a = [a]; return a; }
function f(n) { return { get x() { return n > 0 ? f(n - 1) : 0; } }.x; }
f(110); nest(2040)
// ---
// A stack trace taken in a getter names the same frames.
function inner() { return new Error('t').stack; }
var o = { get mid() { return inner(); } };
function outer() { return { get top() { return o.mid; } }.top; }
outer()
// ---
// Meter-heavy getter loops: 40,000 short getter calls, among which the loop's meter checks
// fall.
var o = { get x() { return 1; } }, s = 0;
for (var i = 0; i < 20000; i++) s += o.x;
var c = Object.create(Object.create(o));
for (var i = 0; i < 20000; i++) s += c.x;
s
