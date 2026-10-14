// A quiescent machine whose container carries every optional atom the
// writer knows, so one snapshot exercises every section encoder:
// `tests/streaming_identity.rs` asserts the coverage and compares the
// streaming writer's bytes against the image writer's, live and through
// a restore. Extend it when a format adds an atom; the coverage assertion
// names the one that is missing.
var arr = [1, 'two', 3.5];                                  // ARRY
var idx = {}; idx[3] = 'x'; idx[7] = arr;                   // IDXP
var m = new Map([[1, 'a'], ['b', arr]]); m.delete(1); m.set(1, 'c');
var s = new Set([3, 1, 2]); var wm = new WeakMap(); wm.set(idx, 1); // COLL
var sym = Symbol.for('registered');                         // REGY
function fail() { return new RangeError('boom'); }
var err = fail(); var stack = err.stack;                    // ERRD, ESTK
var buffer = new ArrayBuffer(16);
var view = new DataView(buffer, 4, 8);
var bytes = new Uint16Array(buffer, 2, 4); view.setUint16(0, 258, true); // ABUF, TARR, DVIW
var boxed = [new Number(5), new String('str'), new Boolean(true)]; // WRAP
var re = /a(b)/g; re.exec('xab');                           // REGX
var args; (function () { args = arguments; })(10, 32);      // ARGB
var dur = Temporal.Duration.from({ hours: 2, minutes: 5 });
var inst = Temporal.Instant.fromEpochMilliseconds(86400000); // TMPR
var mit = m.entries(); mit.next();
var ait = arr[Symbol.iterator](); ait.next();
var sit = 'xyz'[Symbol.iterator](); sit.next();             // ITER
var d = new Date(0); d.setUTCFullYear(2000);                // DATE
function make() { var x = 4; return function () { return ++x; }; }
var f = make(); f(); var bound = f.bind(null, 1);
class Base { constructor() { this.v = 1; } }
class Derived extends Base { constructor() { super(); } }
var derived = new Derived();                                // FUNC
var proxy = new Proxy({ x: 3 }, { get(t, k) { return t[k] + 1; } });
var revocable = Proxy.revocable({}, {});                    // PROX
var n = 4; var acc = { get x() { return n; }, set x(v) { n = v; } }; // ACCS
class C { #x = 4; get #y() { return this.#x; } inc() { return ++this.#x + this.#y; } }
var c = new C(); c.inc();                                   // PRIV
var count = 0; var ds = new DisposableStack(); ds.defer(() => count++); // DISP
function* g() { try { yield 10; yield 20; } finally { count++; } }
var gen = g(); gen.next();                                  // GENR
var resolve; var out = 0;
var p = new Promise(r => resolve = r); p.then(v => out = v + 1);
var all = Promise.all([p, new Promise(() => {})]);          // PRMS
var release; var gate = new Promise(r => release = r);
async function af(x) { try { x += await gate; return x; } finally { count++; } }
var afp = af(1);
async function* ag(start) { var y = yield start; var z = await gate; yield z + y; }
var agi = ag(5); agi.next();
var seen = 'none'; var tag = { mark: 'T' };
Array.fromAsync([gate, 2, 3], function (v, i) { return this.mark + (v * 10 + i); }, tag)
  .then(function (o) { seen = o.join('|'); });               // ASYN
var nf = new Intl.NumberFormat('en', { minimumFractionDigits: 2 });
var boundFormat = nf['for' + 'mat'];                        // INTL, IBFN, NFLR
var lf = new Intl.ListFormat('en', { type: 'conjunction' });
var sg = new Intl.Segmenter('en'); var seg = sg.segment('ab');
var segIt = seg[Symbol.iterator](); segIt.next();
var coll = new Intl.Collator('en'); var pr = new Intl.PluralRules('en');
var loc = new Intl.Locale('en-US'); var dtf = new Intl.DateTimeFormat('en');
var weakTarget = { v: 1 }; var weakToken = {};
var weak = new WeakRef(weakTarget);                         // WREF
var registry = new FinalizationRegistry(function (held) { count += held; });
registry.register(weakTarget, 1, weakToken);                // FREG
0
