// A1: callback-taking Array methods on arrays and on array-likes (the generic
// paths that push their own result), with a throwing callback and a holey array.
function s(v) { try { return typeof v === 'symbol' ? v.toString() : (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v)); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var a = [1, 2, , 4, 5];
var al = { length: 4, 0: 'a', 1: 'b', 3: 'd' };
var out = [];
var methods = ['forEach', 'map', 'some', 'every', 'find', 'findIndex', 'filter', 'reduce', 'reduceRight', 'findLast', 'findLastIndex'];
for (var i = 0; i < methods.length; i++) {
  var m = methods[i];
  out.push(m, t(function () { var log = []; var r = a[m](function (x, k) { log.push(k); return typeof x === 'number' ? x > 2 : x; }, 0); return [r, log.join('')]; }));
  out.push(t(function () { var log = []; var r = Array.prototype[m].call(al, function (x, k) { log.push(k); return x === 'b'; }, ''); return [r, log.join('')]; }));
  out.push(t(function () { return a[m](function () { throw new RangeError('cb ' + m); }); }));
  out.push(t(function () { return a[m]('not callable'); }));
  out.push(t(function () { return Array.prototype[m].call(null, function () {}); }));
}
out.join('\n')
// ---
// A1: the non-callback Array methods, fast and generic paths.
function s(v) { try { return typeof v === 'symbol' ? v.toString() : (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v)); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
function al() { return { length: 5, 0: 3, 1: 1, 2: 2, 3: 0, 4: 'x' }; }
var out = [];
var cases = [
  ['push', [9, 8]], ['pop', []], ['indexOf', [2]], ['includes', ['x']], ['lastIndexOf', [1]],
  ['fill', [0, 1, 3]], ['reverse', []], ['slice', [1, -1]], ['concat', [[7], 8]], ['at', [-1]],
  ['shift', []], ['unshift', [5, 6]], ['copyWithin', [0, 3]], ['with', [1, 'w']], ['toReversed', []],
  ['splice', [1, 2, 'a', 'b', 'c']], ['toSpliced', [0, 1]], ['flat', [2]], ['flatMap', [function (x) { return [x, [x]]; }]],
  ['join', ['-']], ['join', [{ toString: function () { return '+'; } }]], ['join', []], ['toString', []],
  ['sort', []], ['sort', [function (x, y) { return String(y) < String(x) ? -1 : 1; }]], ['toSorted', []], ['toLocaleString', []],
  ['values', []], ['keys', []], ['entries', []]
];
for (var i = 0; i < cases.length; i++) {
  var c = cases[i];
  out.push(c[0], t(function () { var arr = [3, 1, [2, [4, [5]]], 0, 'x']; var r = arr[c[0]].apply(arr, c[1]); return [r && r.next ? Array.from(r) : r, arr]; }));
  out.push(t(function () { var o = al(); var r = Array.prototype[c[0]].apply(o, c[1]); return [r && r.next ? Array.from(r) : r, o]; }));
  out.push(t(function () { var o = Object.freeze([1, 2, 3]); return o[c[0]].apply(o, c[1]); }));
  out.push(t(function () { return Array.prototype[c[0]].apply('str', c[1]); }));
}
out.push(t(function () { return Array.from({ length: 3 }, function (v, k) { return k * k; }); }));
out.push(t(function () { return Array.from(new Set([1, 1, 2])); }));
out.push(t(function () { return Array.from('héllo'); }));
out.push(t(function () { return Array.of(1, 2, 3); }));
out.push(t(function () { return [Array.isArray([]), Array.isArray(new Proxy([], {})), Array.isArray({})]; }));
out.push(t(function () { var arr = []; arr.length = 3; return arr.join(); }));
out.push(t(function () { return [1, [2, [3, [4]]]].flat(Infinity); }));
out.join('\n')
// ---
// A1: Array.fromAsync and Promise statics and prototype methods drained through jobs.
var log = [];
function rec(tag) { return function (v) { log.push(tag + ':' + (v && v.message ? v.name + ':' + v.message : JSON.stringify(v))); }; }
Array.fromAsync([1, Promise.resolve(2), 3]).then(rec('fromAsync'), rec('fromAsyncE'));
Array.fromAsync({ length: 2, 0: 'a', 1: 'b' }, function (x) { return x + x; }).then(rec('fromAsync2'));
Promise.all([1, Promise.resolve(2)]).then(rec('all'));
Promise.allSettled([1, Promise.reject(new Error('no'))]).then(function (r) { log.push('allSettled:' + r.map(function (x) { return x.status; }).join()); });
Promise.race([new Promise(function () {}), Promise.resolve('r')]).then(rec('race'));
Promise.any([Promise.reject(1), Promise.reject(2)]).catch(function (e) { log.push('any:' + e.name + ':' + e.errors.join()); });
Promise.resolve(1).finally(function () { log.push('finally'); return 9; }).then(rec('afterFinally'));
Promise.reject(new TypeError('x')).finally(function () { log.push('finally2'); }).catch(rec('afterFinally2'));
Promise.reject(3).catch(rec('catch'));
new Promise(function (res, rej) { log.push('executor'); res(Promise.resolve(7)); }).then(rec('thenable'));
try { Promise(function () {}); } catch (e) { log.push('callPromise:' + e.name); }
try { new Promise(5); } catch (e) { log.push('newPromise5:' + e.name); }
class P2 extends Promise {}
var p2 = P2.resolve(4);
log.push('species:' + (p2 instanceof P2) + ':' + (p2.then(function () {}) instanceof P2) + ':' + (Promise[Symbol.species] === Promise));
p2.then(rec('P2'));
Promise.resolve({ then: function (r) { log.push('thenjob'); r('T'); } }).then(rec('thenObj'));
(async function () { await null; log.push('async1'); try { await Promise.reject(new Error('aw')); } catch (e) { log.push('caught:' + e.message); } return 'done'; })().then(rec('async'));
var res = '';
Promise.resolve().then(function () {}).then(function () {}).then(function () {}).then(function () {}).then(function () {}).then(function () {}).then(function () { res = log.join('|'); });
log.join('|')
// ---
// flags: --eval-compiler
// A1: constructors called with and without `new`, including guarded arms that fall
// through to their unguarded sibling (Boolean, Map/Set, WeakMap/WeakSet, Compartment,
// ArrayBuffer, TypedArray, DataView, Promise).
function s(v) { try { return typeof v === 'symbol' ? v.toString() : (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + ':' + String(v) : typeof v + ':' + String(v)); } catch (e) { return '?' + Object.prototype.toString.call(v); } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var ctors = ['Boolean', 'Number', 'String', 'BigInt', 'Object', 'Error', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'SuppressedError', 'DisposableStack', 'AsyncDisposableStack',
  'Iterator', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'ArrayBuffer', 'SharedArrayBuffer',
  'Uint8Array', 'Float64Array', 'BigInt64Array', 'Int16Array', 'DataView', 'Promise', 'RegExp', 'Function', 'Date',
  'Symbol'];
for (var i = 0; i < ctors.length; i++) {
  var C = globalThis[ctors[i]];
  if (typeof C !== 'function') { out.push(ctors[i] + ' missing'); continue; }
  out.push(ctors[i]);
  out.push(t(function () { return C(); }));
  out.push(t(function () { return C(1); }));
  out.push(t(function () { return C([[{}, 2]]); }));
  out.push(t(function () { return new C(); }));
  out.push(t(function () { return new C(8); }));
  out.push(t(function () { return new C('7'); }));
  out.push(t(function () { return Reflect.construct(C, [4], Object); }));
}
var TA = Object.getPrototypeOf(Uint8Array);
out.push(t(function () { return TA(); }), t(function () { return new TA(); }));
out.push(t(function () { return new DataView(new ArrayBuffer(8), 2, 4).byteLength; }));
out.push(t(function () { return new Uint8Array([1, 2, 300]).join(); }));
out.push(t(function () { return new Uint16Array(new ArrayBuffer(8), 2).length; }));
out.push(t(function () { return new Float32Array(new Set([1.5, 2.5])).join(); }));
out.push(t(function () { return new Map([[1, 2]]).get(1); }), t(function () { return new Set('abca').size; }));
out.push(t(function () { var k = {}; return new WeakMap([[k, 1]]).get(k); }), t(function () { return new WeakSet([1]); }));
out.push(t(function () { return eval('1 + 1'); }), t(function () { return new eval('1'); }), t(function () { return eval(5); }));
out.push(t(function () { return Function('a', 'b', 'return a + b')(2, 3); }), t(function () { return new Function('return this')(); }));
out.push(t(function () { return new (Object.getPrototypeOf(function* () {}).constructor)('yield 1')().next().value; }));
out.push(t(function () { return Object(1n); }), t(function () { return new Object('s').length; }), t(function () { return Object(null); }));
out.push(t(function () { return Symbol('d').description; }), t(function () { return new Symbol('d'); }));
out.join('\n')
// ---
// A1: `new Symbol()` on its own (the `Symbol if !has_target` arm falls through to
// the catch-all).
new Symbol('x')
// ---
// flags: --eval-compiler
// A1: derived constructors reach the native through `super()` (pending new.target,
// derived_native_construct) for every split family.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + ':' + String(v) : typeof v + ':' + String(v); } catch (e) { return '?' + Object.prototype.toString.call(v); } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var names = ['Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'AggregateError', 'Promise',
  'ArrayBuffer', 'Uint8Array', 'DataView', 'Date', 'RegExp', 'Boolean', 'Number', 'String', 'Function', 'Iterator',
  'DisposableStack'];
for (var i = 0; i < names.length; i++) {
  var B = globalThis[names[i]];
  if (typeof B !== 'function') { out.push(names[i] + ' missing'); continue; }
  out.push(names[i], t(function () {
    class D extends B { constructor() { var args = names[i] === 'DataView' ? [new ArrayBuffer(4)] : names[i] === 'Promise' ? [function () {}] : names[i] === 'Uint8Array' || names[i] === 'ArrayBuffer' ? [3] : names[i] === 'AggregateError' ? [[]] : []; super(...args); this.tag = 1; } }
    var d = new D();
    return [Object.getPrototypeOf(d) === D.prototype, d instanceof B, d.tag].join();
  }));
  out.push(t(function () { function F() {} F.prototype = { marker: 1 }; var o = Reflect.construct(B, names[i] === 'DataView' ? [new ArrayBuffer(4)] : names[i] === 'Promise' ? [function () {}] : [], F); return [o.marker, Object.getPrototypeOf(o) === F.prototype].join(); }));
}
var I = globalThis.Intl;
if (I) {
  var ins = ['Collator', 'NumberFormat', 'DateTimeFormat', 'PluralRules', 'ListFormat', 'Segmenter', 'Locale'];
  for (var j = 0; j < ins.length; j++) {
    var IB = I[ins[j]];
    if (typeof IB !== 'function') { out.push(ins[j] + ' missing'); continue; }
    out.push(ins[j], t(function () { class D extends IB { constructor() { super(ins[j] === 'Locale' ? 'en-US' : 'en'); } } var d = new D(); return Object.getPrototypeOf(d) === D.prototype; }));
    out.push(t(function () { return IB('en'); }), t(function () { return new IB('en-u-co-phonebk'); }), t(function () { return new IB('not a tag!'); }));
  }
}
var T = globalThis.Temporal;
if (T) {
  var tns = ['Instant', 'Duration', 'PlainDate', 'PlainTime', 'PlainDateTime', 'PlainYearMonth', 'PlainMonthDay', 'ZonedDateTime'];
  for (var k = 0; k < tns.length; k++) {
    var TB = T[tns[k]];
    if (typeof TB !== 'function') { out.push(tns[k] + ' missing'); continue; }
    out.push(tns[k], t(function () { return TB(); }), t(function () { return new TB(); }), t(function () { return new TB(1, 2, 3); }), t(function () { return new TB(0n, 'UTC'); }));
    out.push(t(function () { class D extends TB {} return Object.getPrototypeOf(new D(2020, 1, 1)) === D.prototype; }));
  }
}
out.join('\n')
// ---
// A1: iterator helpers (each IteratorHelper op range), iterator protocol methods,
// generators and async generators.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
function* g(n) { try { for (var i = 0; i < n; i++) yield i; } finally { log.push('fin' + n); } }
var log = [];
var out = [];
var ops = ['map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray', 'forEach', 'some', 'every', 'find'];
for (var i = 0; i < ops.length; i++) {
  var op = ops[i];
  if (typeof Iterator === 'undefined' || typeof Iterator.prototype[op] !== 'function') { out.push(op + ' missing'); continue; }
  out.push(op, t(function () {
    var arg = op === 'take' || op === 'drop' ? 2 : op === 'flatMap' ? function (x) { return [x, x]; } : function (x, k) { return typeof x === 'number' ? x * 2 + (k | 0) : x; };
    var r = op === 'reduce' ? g(5)[op](function (a, b) { return a + b; }, 0) : g(5)[op](arg);
    return r && typeof r.next === 'function' ? [r.next(), r.next(), r.return(), r.next()] : r;
  }));
  out.push(t(function () { return g(3)[op](function () { throw new Error('h' + op); }); }));
  out.push(t(function () { var it = g(3)[op](op === 'take' || op === 'drop' ? -1 : 'nope'); return it.next ? it.next() : it; }));
  out.push(t(function () { return Iterator.prototype[op].call({ next: 1 }, function () {}); }));
}
out.push(t(function () { return Iterator.from({ next: function () { return { done: true }; } }).toArray(); }));
out.push(t(function () { return Iterator.from([1, 2]).next(); }));
out.push(t(function () { var w = Iterator.from({ next: function () { return { value: 1, done: false }; }, return: function () { log.push('wret'); return {}; } }); return [w.next(), w.return()]; }));
out.push(t(function () { return [Iterator.prototype.constructor === Iterator, Iterator.prototype[Symbol.toStringTag]]; }));
out.push(t(function () { var o = Object.create(Iterator.prototype); o.constructor = 5; o[Symbol.toStringTag] = 'z'; return [Object.getOwnPropertyDescriptor(o, 'constructor').value, o[Symbol.toStringTag]]; }));
out.push(t(function () { Iterator.prototype.constructor = 1; }));
out.push(t(function () { var it = g(4); return [it.next(), it.return(9), it.next()]; }));
out.push(t(function () { var it = g(4); it.next(); return it.throw(new Error('thr')); }));
out.push(t(function () { return [[1, 2].values().next(), new Map([[1, 2]]).entries().next(), new Set([3]).values().next(), 'ab'.matchAll(/./g).next().value[0]]; }));
var ag = (async function* () { yield 1; yield 2; })();
ag.next().then(function (r) { log.push('ag' + r.value); });
ag.return(5).then(function (r) { log.push('agr' + r.value + r.done); });
ag.throw(new Error('agt')).catch(function (e) { log.push('agt:' + e.message); });
out.push(t(function () { var AIP = Object.getPrototypeOf(Object.getPrototypeOf(ag)); return AIP[Symbol.asyncIterator] && AIP[Symbol.asyncIterator].call(7); }));
out.join('\n') + '\n' + log.join()
// ---
// A1: Map/Set/WeakMap/WeakSet methods, size getters, set methods, groupBy and brand errors.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v instanceof Map ? Array.from(v) : v instanceof Set ? Array.from(v) : v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var m = new Map([[1, 'a'], [2, 'b']]), st = new Set([1, 2, 3]), k = {}, wm = new WeakMap(), ws = new WeakSet();
out.push(t(function () { return [m.size, st.size, m.set(3, 'c').get(3), m.has(2), m.delete(2), m.delete(2), m.size]; }));
out.push(t(function () { return [st.add(4).has(4), st.delete(1), st.size]; }));
out.push(t(function () { return [wm.set(k, 1).get(k), wm.has(k), wm.delete(k), ws.add(k).has(k), ws.delete(k)]; }));
out.push(t(function () { var r = []; m.forEach(function (v, kk) { r.push(kk + v); if (kk === 1) m.set(9, 'z'); }); return r; }));
out.push(t(function () { var r = []; st.forEach(function (v) { r.push(v); }); return r; }));
out.push(t(function () { return [Array.from(m.keys()), Array.from(m.values()), Array.from(st.entries())]; }));
out.push(t(function () { var mm = new Map(m); mm.clear(); return mm.size; }));
var ops = ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'];
for (var i = 0; i < ops.length; i++) {
  var op = ops[i];
  if (typeof st[op] !== 'function') { out.push(op + ' missing'); continue; }
  out.push(op, t(function () { return st[op](new Set([2, 5])); }), t(function () { return st[op]({ size: 1, has: function (x) { return x === 3; }, keys: function () { return [3][Symbol.iterator](); } }); }));
  out.push(t(function () { return st[op]([1]); }), t(function () { return Set.prototype[op].call(m, st); }));
}
out.push(t(function () { return Map.prototype.get.call(st, 1); }), t(function () { return Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(st); }));
out.push(t(function () { return Set.prototype.add.call(new WeakSet(), 1); }), t(function () { return wm.set(1, 1); }));
out.push(t(function () { return Map.groupBy([1, 2, 3, 4], function (x) { return x % 2; }); }));
out.push(t(function () { return Object.groupBy([1, 2, 3, 4], function (x) { return x % 2 ? 'odd' : 'even'; }); }));
if (typeof m.getOrInsert === 'function') {
  out.push(t(function () { return [m.getOrInsert(7, 'n'), m.getOrInsert(7, 'q'), m.getOrInsertComputed(8, function (x) { return 'c' + x; })]; }));
  out.push(t(function () { var w = new WeakMap(); return [w.getOrInsert(k, 1), w.getOrInsertComputed(k, function () { return 2; })]; }));
}
out.push(t(function () { return Map.prototype.clear.call(Object.freeze(new Map())); }));
out.join('\n')
// ---
// A1: RegExp methods and String protocol methods (Symbol.match/replace/split/search
// dispatch, callbacks, non-RegExp objects).
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var re = /(\w)(\d)?/g;
out.push(t(function () { re.lastIndex = 0; return [re.exec('a1b'), re.lastIndex, re.test('zz'), re.toString(), String(re.compile('x', 'i'))]; }));
out.push(t(function () { return ['a1b2'.match(/\d/g), Array.from('a1b2'.matchAll(/\d/g), function (m) { return m.index; }), 'a1b2'.search(/\d/), 'a1b2'.split(/\d/), 'a1b2'.replace(/\d/g, function (d) { return '<' + d + '>'; }), 'a1b2'.replaceAll(/\d/g, '$&$&')]; }));
out.push(t(function () { return RegExp.prototype[Symbol.split].call(/-/, 'a-b-c', 2); }));
out.push(t(function () { return RegExp.prototype.exec.call({}, 'x'); }));
out.push(t(function () { return RegExp[Symbol.species] === RegExp; }));
out.push(t(function () { return 'abc'.replaceAll(/b/, 'x'); }));
out.push(t(function () { var o = {}; o[Symbol.match] = function (s) { return 'M' + s; }; o[Symbol.replace] = function (s, r) { return 'R' + s + r; }; o[Symbol.search] = function () { return 42; }; o[Symbol.split] = function (s, l) { return ['S', s, l]; }; o[Symbol.matchAll] = function () { return 'MA'; };
  return ['q'.match(o), 'q'.replace(o, 'r'), 'q'.replaceAll(o, 'r'), 'q'.search(o), 'q'.split(o, 3), 'q'.matchAll(o)]; }));
out.push(t(function () { var o = { toString: function () { return 'b'; } }; return ['abcb'.split(o), 'abcb'.replace(o, 'X'), 'abcb'.indexOf(o), 'abcb'.includes(o)]; }));
out.push(t(function () { return 'x'.includes(/x/); }), t(function () { return 'x'.startsWith(/x/); }));
out.push(t(function () { var r = /a/g; r[Symbol.match] = false; return 'xa'.includes(r); }));
out.push(t(function () { return String.prototype.trim.call(null); }));
var sm = ['charCodeAt', 'codePointAt', 'charAt', 'at', 'slice', 'substring', 'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'concat',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'localeCompare', 'normalize', 'repeat', 'trim', 'trimStart', 'trimEnd',
  'padStart', 'padEnd', 'isWellFormed', 'toWellFormed'];
for (var i = 0; i < sm.length; i++) {
  var name = sm[i];
  out.push(name, t(function () { return '  Abé\ud800C  '[name](1, 3); }), t(function () { return String.prototype[name].call(12345, 'NFD'); }), t(function () { return String.prototype[name].call(Symbol()); }));
}
out.push(t(function () { return 'ab'.repeat(-1); }), t(function () { return 'x'.normalize('bad'); }), t(function () { return Array.from('a😀b'[Symbol.iterator]()); }));
out.push(t(function () { return [String.fromCharCode(65, 66.7, 65601), String.fromCodePoint(0x1f600), String.raw({ raw: ['a', 'b', 'c'] }, 1, 2)]; }));
out.push(t(function () { return String.fromCodePoint(-1); }));
out.join('\n')
// ---
// A1: Object statics on Proxy operands (routed through the proxy-aware MOP before the
// match) and on plain operands; Object.prototype methods incl. toString on undefined/null.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var log = [];
var target = { a: 1, b: 2 };
var handler = {};
['get', 'set', 'has', 'deleteProperty', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions'].forEach(function (trap) {
  handler[trap] = function () { log.push(trap); return Reflect[trap].apply(null, arguments); };
});
var p = new Proxy(target, handler);
var out = [];
var statics = ['keys', 'values', 'entries', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'getOwnPropertyDescriptors', 'getPrototypeOf', 'isExtensible', 'isFrozen', 'isSealed', 'freeze', 'seal', 'preventExtensions'];
for (var i = 0; i < statics.length; i++) {
  log.length = 0;
  var r1 = t(function () { return Object[statics[i]](p); });
  out.push(statics[i], r1, log.join(','));
  out.push(t(function () { return Object[statics[i]]({ x: 1 }); }), t(function () { return Object[statics[i]](3); }), t(function () { return Object[statics[i]](); }));
}
var p2 = new Proxy({}, handler);
log.length = 0;
out.push(t(function () { return Object.defineProperty(p2, 'k', { value: 1, configurable: true }) === p2; }), log.join(','));
log.length = 0;
out.push(t(function () { return Object.defineProperties(p2, { m: { value: 2 } }) === p2; }), log.join(','));
log.length = 0;
out.push(t(function () { return Object.getOwnPropertyDescriptor(p2, 'k'); }), log.join(','));
log.length = 0;
out.push(t(function () { return Object.setPrototypeOf(p2, null) === p2; }), log.join(','));
log.length = 0;
out.push(t(function () { return [Object.hasOwn(p2, 'k'), Object.prototype.hasOwnProperty.call(p2, 'k'), Object.prototype.propertyIsEnumerable.call(p2, 'k')]; }), log.join(','));
log.length = 0;
out.push(t(function () { return Object.assign({}, p, null, 'xy'); }), t(function () { return Object.assign(p2, { z: 1 }); }), log.join(','));
out.push(t(function () { return Object.fromEntries(new Map([['q', 1]])); }), t(function () { return Object.create(p, { w: { value: 1, enumerable: true } }); }));
out.push(t(function () { return [Object.is(NaN, NaN), Object.is(0, -0)]; }));
out.push(t(function () { var r = Proxy.revocable({}, {}); r.revoke(); r.revoke(); return Object.keys(r.proxy); }));
out.push(t(function () { var r = Proxy.revocable({}, {}); r.revoke(); return Object.prototype.toString.call(r.proxy); }));
out.push(t(function () { return [Object.prototype.toString.call(undefined), Object.prototype.toString.call(null), Object.prototype.toString.call(1), Object.prototype.toString.call([]), Object.prototype.toString.call(p), Object.prototype.toString.call(function () {})]; }));
out.push(t(function () { var o = {}; o[Symbol.toStringTag] = 'Tag'; return [String(o), o.toLocaleString(), ({}).valueOf.call(5), Object.prototype.valueOf.call(null)]; }));
out.push(t(function () { return Object.prototype.toLocaleString.call(undefined); }));
out.push(t(function () { return [Object.prototype.isPrototypeOf.call(Object.prototype, p), Object.prototype.isPrototypeOf.call(1, {})]; }));
out.push(t(function () { return [new Number(5).valueOf(), new String('s').toString(), new Boolean(false).valueOf(), Number.prototype.valueOf.call('x')]; }));
out.join('\n')
// ---
// A1: Function, Reflect, Symbol, Error, Number, BigInt, Math, JSON and the global
// functions.
function s(v) { try { return typeof v === 'symbol' ? v.toString() : (typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v)); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
function f(a, b) { return [this && this.tag, a, b]; }
out.push(t(function () { return [f.call({ tag: 1 }, 2, 3), f.apply({ tag: 4 }, [5]), f.bind({ tag: 6 }, 7)(8), f.bind(null).name, f.bind().length]; }));
out.push(t(function () { return f.apply(null, 5); }), t(function () { return Function.prototype.call.call(1); }), t(function () { return Function.prototype(); }));
out.push(t(function () { return [f.toString().slice(0, 12), Function.prototype.toString.call(Math.max), Function.prototype.toString.call(class A {})]; }));
out.push(t(function () { return Function.prototype.toString.call({}); }));
out.push(t(function () { return [Function.prototype[Symbol.hasInstance].call(f, new f()), Function.prototype[Symbol.hasInstance].call({}, {})]; }));
out.push(t(function () { return [Error.prototype.toString.call({ name: 'N', message: 'M' }), String(new TypeError('tt')), Error.prototype.toString.call(1)]; }));
out.push(t(function () { var e = new Error('st'); var d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack'); return [typeof e.stack, d ? typeof d.get : 'none', (e.stack = 'x', e.stack)]; }));
var sy = Symbol('desc');
out.push(t(function () { return [sy.toString(), sy.valueOf() === sy, sy[Symbol.toPrimitive]() === sy, sy.description, Symbol().description, Symbol.for('k') === Symbol.for('k'), Symbol.keyFor(Symbol.for('k')), Symbol.keyFor(sy)]; }));
out.push(t(function () { return Symbol.prototype.toString.call(1); }), t(function () { return Symbol.keyFor('x'); }), t(function () { return Symbol.for({ toString: function () { throw new Error('ts'); } }); }));
out.push(t(function () { return [(255n).toString(16), BigInt.asIntN(8, 255n), BigInt.asUintN(8, -1n), (5n).valueOf(), (12345678901234567890n).toLocaleString()]; }));
out.push(t(function () { return BigInt.asIntN(-1, 1n); }), t(function () { return BigInt.prototype.toString.call(1); }));
out.push(t(function () { return [Math.max(1, 3, 2), Math.min(), Math.hypot(3, 4), Math.sign(-3), Math.fround(5.5), Math.clz32(1), Math.imul(3, 4), Math.atan2(1, 1), Math.round(-0.5), Math.trunc(-4.7), Math.cbrt(27)]; }));
out.push(t(function () { return Math.max({ valueOf: function () { throw new Error('vo'); } }); }));
out.push(t(function () { var o = { a: 1 }; var r = []; return [Reflect.getPrototypeOf(o) === Object.prototype, Reflect.setPrototypeOf(o, null), Reflect.isExtensible(o), Reflect.preventExtensions(o), Reflect.getOwnPropertyDescriptor(o, 'a'), Reflect.defineProperty(o, 'b', { value: 1 }), Reflect.ownKeys(o), Reflect.has(o, 'a'), Reflect.get(o, 'a'), Reflect.set(o, 'a', 2), Reflect.deleteProperty(o, 'a'), Reflect.apply(f, { tag: 9 }, [1]), Reflect.construct(Date, [0]).getTime()]; }));
out.push(t(function () { return Reflect.get(1, 'a'); }), t(function () { return Reflect.construct(function () {}, [], Math.max); }), t(function () { return Reflect.apply(1); }));
out.push(t(function () { return [Number.isFinite(1), Number.isInteger(1.5), Number.isNaN(NaN), Number.isSafeInteger(2 ** 53), (255).toString(2), (1234.5).toLocaleString(), Number.prototype.toString.call(1, 37)]; }));
out.push(t(function () { return [parseInt('0x1f'), parseInt('z', 36), parseFloat('3.5e2x'), isNaN('a'), isFinite('1')]; }));
out.push(t(function () { return [JSON.stringify({ a: [1, { b: 2 }], c: undefined }, null, 2), JSON.parse('{"x":[1,2]}', function (k, v) { return typeof v === 'number' ? v * 10 : v; })]; }));
out.push(t(function () { return JSON.parse('{bad'); }), t(function () { var o = {}; o.o = o; return JSON.stringify(o); }));
out.join('\n')
// ---
// A1: typed arrays, ArrayBuffer, DataView and Atomics.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + (ArrayBuffer.isView(v) ? Array.prototype.join.call(v) : JSON.stringify(v)) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var ta = new Int16Array([5, -3, 9, 1]);
var tms = ['copyWithin', 'fill', 'set', 'reverse', 'join', 'values', 'keys', 'entries', 'slice', 'subarray', 'map', 'filter', 'sort', 'toLocaleString',
  'at', 'indexOf', 'includes', 'lastIndexOf', 'forEach', 'every', 'some', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'reduceRight', 'toReversed', 'toSorted', 'with'];
for (var i = 0; i < tms.length; i++) {
  var name = tms[i];
  out.push(name, t(function () { var c = ta.slice(); var r = c[name](name === 'set' ? [7] : name === 'map' || name === 'filter' || name === 'forEach' || name === 'every' || name === 'some' || name.indexOf('find') === 0 ? function (x) { return x > 0; } : name === 'reduce' || name === 'reduceRight' ? function (a, b) { return a + b; } : name === 'with' ? 1 : name === 'join' ? '/' : 1, name === 'with' ? 42 : 2); return [r && r.next ? Array.from(r) : r, c]; }));
  out.push(t(function () { return Object.getPrototypeOf(Int8Array).prototype[name].call([1, 2]); }));
}
out.push(t(function () { return [ta.length, ta.byteLength, ta.byteOffset, ta.buffer.byteLength, ta[Symbol.toStringTag]]; }));
out.push(t(function () { return [Uint8Array.from([1, 2, 3], function (x) { return x * 2; }), Float64Array.of(1.5, 2)]; }));
var ab = new ArrayBuffer(8);
out.push(t(function () { return [ab.detached, ab.slice(2, 4).byteLength, ab.slice(-3).byteLength]; }));
out.push(t(function () { var b2 = ab.transfer(); return [ab.detached, b2.byteLength, b2.transferToFixedLength(4).byteLength]; }));
out.push(t(function () { return ab.slice(0); }));
out.push(t(function () { return [ArrayBuffer.isView(ta), ArrayBuffer.isView(ab), ArrayBuffer[Symbol.species] === ArrayBuffer]; }));
var dv = new DataView(new ArrayBuffer(16), 0);
out.push(t(function () { dv.setInt32(0, -2); dv.setFloat64(8, 1.5, true); dv.setBigUint64(0, 3n); return [dv.getInt32(4), dv.getFloat64(8, true), dv.getUint8(7), dv.getBigInt64(0), dv.byteLength, dv.byteOffset, dv.buffer.byteLength]; }));
out.push(t(function () { return dv.getInt32(14); }), t(function () { return DataView.prototype.getInt8.call({}, 0); }));
var ia = new Int32Array(new SharedArrayBuffer(16));
out.push(t(function () { return [Atomics.add(ia, 0, 5), Atomics.sub(ia, 0, 2), Atomics.load(ia, 0), Atomics.store(ia, 1, 7), Atomics.exchange(ia, 1, 8), Atomics.compareExchange(ia, 1, 8, 9), Atomics.and(ia, 1, 1), Atomics.or(ia, 1, 2), Atomics.xor(ia, 1, 3), Atomics.isLockFree(4), Atomics.notify(ia, 0, 1)]; }));
out.push(t(function () { return Atomics.wait(ia, 0, 1, 0); }), t(function () { return Atomics.add([1], 0, 1); }));
if (typeof $262 !== 'undefined' && $262.detachArrayBuffer) out.push(t(function () { var b = new ArrayBuffer(4); $262.detachArrayBuffer(b); return b.detached; }));
out.join('\n')
// ---
// A1: Date and Temporal methods.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + ':' + String(v) : typeof v + ':' + String(v); } catch (e) { return '?' + Object.prototype.toString.call(v); } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var d = new Date(Date.UTC(2020, 1, 29, 12, 30, 15, 250));
out.push(t(function () { return [d.toISOString(), d.getUTCDay(), d.valueOf(), d.toJSON(), Date.UTC(2000, 0), Date.parse('2001-02-03T04:05:06Z'), d[Symbol.toPrimitive]('number'), d[Symbol.toPrimitive]('default').slice(0, 3)]; }));
out.push(t(function () { var e = new Date(0); e.setUTCFullYear(1999, 11, 31); e.setUTCHours(23, 59); return e.toISOString(); }));
out.push(t(function () { return Date.prototype.getTime.call({}); }), t(function () { return d[Symbol.toPrimitive]('bad'); }), t(function () { return new Date(NaN).toISOString(); }));
out.push(t(function () { return typeof Date(); }), t(function () { return typeof Date.now(); }));
var T = globalThis.Temporal;
if (T) {
  out.push(t(function () { var i = T.Instant.fromEpochMilliseconds(1000); return [i.toString(), i.add({ hours: 1 }).epochMilliseconds, T.Instant.compare(i, T.Instant.from('1970-01-01T00:00:02Z')), i.equals(i), i.round({ smallestUnit: 'second' }).toJSON(), i.until(T.Instant.fromEpochNanoseconds(5000000000n)).toString()]; }));
  out.push(t(function () { return T.Instant.prototype.valueOf.call(T.Instant.fromEpochMilliseconds(0)); }));
  out.push(t(function () { var du = T.Duration.from({ hours: 1, minutes: 90 }); return [du.toString(), du.negated().abs().toJSON(), du.add({ minutes: 1 }).toString(), du.round({ largestUnit: 'hour' }).toString(), du.total('minute'), T.Duration.compare(du, { hours: 2 }), du.with({ seconds: 3 }).toString()]; }));
  out.push(t(function () { var pd = T.PlainDate.from('2020-02-29'); return [pd.add({ years: 1 }).toString(), pd.dayOfWeek, pd.toPlainDateTime().toString(), pd.until('2021-01-01').toString(), pd.with({ day: 1 }).toString()]; }));
  out.push(t(function () { return [T.PlainTime.from('12:34').add({ minutes: 30 }).toString(), T.PlainYearMonth.from('2020-02').daysInMonth, T.PlainMonthDay.from('02-29').toString()]; }));
  out.push(t(function () { var z = T.ZonedDateTime.from('2020-01-01T00:00[UTC]'); return [z.toString(), z.add({ days: 1 }).epochMilliseconds, z.hoursInDay, z.toInstant().toString()]; }));
  out.push(t(function () { return [typeof T.Now.instant(), typeof T.Now.timeZoneId()]; }));
  out.push(t(function () { return T.PlainDate.from('nope'); }), t(function () { return T.Duration.from({ hours: 1, minutes: -1 }); }));
}
out.join('\n')
// ---
// A1: Intl statics and methods.
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var I = globalThis.Intl;
if (I) {
  out.push(t(function () { return [I.getCanonicalLocales(['EN-us', 'de']), I.supportedValuesOf && I.supportedValuesOf('calendar').length]; }));
  out.push(t(function () { return I.getCanonicalLocales('not a tag!'); }), t(function () { return I.supportedValuesOf('nope'); }));
  out.push(t(function () { var l = new I.Locale('en-latn-us', { calendar: 'gregory' }); return [l.toString(), l.maximize().toString(), l.minimize().toString(), new I.Locale('zh').maximize().toString()]; }));
  out.push(t(function () { var c = new I.Collator('en', { sensitivity: 'base' }); return [c.compare('a', 'B'), c.compare('a', 'á'), ['b', 'a', 'C'].sort(c.compare), c.resolvedOptions(), I.Collator.supportedLocalesOf(['en', 'xx'])]; }));
  out.push(t(function () { var nf = new I.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); return [nf.format(1234.5), nf.formatToParts(-1).length, nf.resolvedOptions().currency, [1, 2].map(nf.format)]; }));
    out.push(t(function () { var pr = new I.PluralRules('en', { type: 'ordinal' }); return [pr.select(1), pr.select(2), pr.select(3), pr.select(11), pr.resolvedOptions().pluralCategories, pr.selectRange && pr.selectRange(1, 2)]; }));
  out.push(t(function () { var lf = new I.ListFormat('en', { type: 'disjunction' }); return [lf.format(['a', 'b', 'c']), lf.formatToParts(['x', 'y']).length, lf.resolvedOptions().type]; }));
  out.push(t(function () { return new I.ListFormat('en').format([1]); }));
  out.push(t(function () { var sg = new I.Segmenter('en', { granularity: 'word' }); var segs = sg.segment('Hi there, you.'); var r = []; for (var x of segs) r.push(x.segment + (x.isWordLike ? '*' : '')); return [r.join('|'), segs.containing(4).segment, sg.resolvedOptions().granularity]; }));
  out.push(t(function () { var dtf = new I.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }); var x = new Date(0); return [dtf.format(x), dtf.formatToParts(x).length, dtf.formatRange && dtf.formatRange(x, new Date(86400000 * 40)), dtf.resolvedOptions().timeZone]; }));
  out.push(t(function () { return new I.DateTimeFormat('en', { timeZone: 'Nowhere/Zone' }); }));
  out.push(t(function () { return [(1234.5).toLocaleString('de-DE'), 'I'.toLocaleLowerCase('tr'), 'a'.localeCompare('b', 'en'), new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' })]; }));
}
out.join('\n')
// ---
// flags: --eval-compiler
// A1: DisposableStack, Compartment, harden/lockdown-style globals and realm methods
// (whatever this build exposes).
function s(v) { try { return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) + JSON.stringify(v) : typeof v + ':' + String(v); } catch (e) { return '?'; } }
function t(f) { try { return s(f()); } catch (e) { return 'E:' + (e && e.name) + ':' + (e && e.message); } }
var out = [];
var log = [];
if (typeof DisposableStack === 'function') {
  out.push(t(function () { var st = new DisposableStack(); st.use({ [Symbol.dispose]: function () { log.push('use'); } }); st.adopt(1, function (v) { log.push('adopt' + v); }); st.defer(function () { log.push('defer'); }); var m2 = st.move(); m2.dispose(); return [st.disposed, m2.disposed, log.join()]; }));
  out.push(t(function () { return new DisposableStack().use(1); }), t(function () { var st = new DisposableStack(); st.dispose(); return st.defer(function () {}); }));
}
if (typeof AsyncDisposableStack === 'function') {
  out.push(t(function () { var st = new AsyncDisposableStack(); st.defer(function () { log.push('adefer'); }); st.disposeAsync().then(function () { log.push('adone'); }); return st.disposed; }));
}
if (typeof Compartment === 'function') {
  out.push(t(function () { var c = new Compartment(); return [c.evaluate('1 + 2'), typeof c.globalThis]; }), t(function () { return Compartment(); }));
}
['harden', 'petrify', 'lockdown'].forEach(function (n) { out.push(n + ':' + typeof globalThis[n]); });
if (typeof harden === 'function') out.push(t(function () { var o = harden({ a: { b: 1 } }); return [Object.isFrozen(o), Object.isFrozen(o.a)]; }));
out.join('\n') + '\n' + log.join()
// ---
// A1: re-entrant native recursion through forEach to the reentry budget (the halt and
// its depth must match).
function r(n) { [0].forEach(function () { r(n + 1); }); }
r(0)
// ---
// A1: re-entrant recursion through the constructor dispatcher (Promise executor) to the
// reentry budget.
function r(n) { new Promise(function () { r(n + 1); }); }
r(0)
// ---
// A1: re-entrant recursion alternating method families (map, replace callback, Reflect.apply,
// Array.from mapper, sort comparator) to the budget.
var n = 0;
function r() {
  n++;
  switch (n % 5) {
    case 0: [1].map(r); break;
    case 1: 'a'.replace(/a/, r); break;
    case 2: Reflect.apply(r, null, []); break;
    case 3: Array.from([1], r); break;
    case 4: [2, 1].sort(function () { r(); return 0; }); break;
  }
  return '';
}
r()
// ---
// A1: re-entrant recursion through Function.prototype.call and iterator helpers, caught at
// each level so the unwinding path runs through every dispatcher frame.
var depth = 0, max = 0;
function r() {
  depth++; if (depth > max) max = depth;
  try { Iterator.from([1]).map(function () { return r.call(null); }).toArray(); } catch (e) { }
  depth--;
  return max;
}
r();
max
