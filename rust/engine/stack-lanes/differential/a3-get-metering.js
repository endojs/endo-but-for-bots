// A3 review: the Array Iterator over a trap-absent Proxy over an array, through every consumer.
var p = new Proxy([1, 2, 3], {});
var r = [];
for (var v of p) r.push(v);
r.push([...p].join(':'), Array.from(p).join(':'), Array.from(p.keys()).join(':'), JSON.stringify(Array.from(p.entries())));
var [a, b, ...rest] = p;
r.push(a, b, rest.length);
var it = Array.prototype.values.call(p);
r.push(JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next()));
r.push(new Set(p).size, new Map([[1, p]]).get(1) === p, Array.from(p, function (x, i) { return x * 10 + i; }).join());
function* g() { yield* p; }
r.push([...g()].join('/'));
r.join()
// ---
// A3 review: Array Iterator over trap-absent chains of length 0..6 over a String wrapper (the
// terminal-wrapper charge, forwarded and not), and the String iterator for contrast.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var r = [];
for (var n = 0; n <= 6; n++) {
  var s = wrap(new String('hél😀'), n);
  r.push(Array.from(Array.prototype.values.call(s)).length);
  r.push([...Array.prototype.keys.call(s)].join(''));
  r.push(Array.from(Array.prototype.entries.call(s)).length);
  r.push([...s].length);
  var it = Array.prototype.values.call(s); it.next(); r.push(it.next().value.charCodeAt(0));
}
r.join('|')
// ---
// A3 review: Array Iterator over trap-absent chains of length 0..5 ending in every terminal kind.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var targets = [
  function () { return [10, , 30]; },
  function () { return { length: 3, 0: 'a', 2: 'c' }; },
  function () { return Object(5); },
  function () { return Object(Symbol('s')); },
  function () { return Object(10n); },
  function () { return Object(true); },
  function () { return function (x, y) {}; },
  function () { return new Uint8Array([7, 8, 9]); },
  function () { return new Float64Array(2); },
  function () { return (function () { return arguments; })(4, 5); },
  function () { return new String(''); },
  function () { return Object.create(null); },
  function () { return Object.create([1, 2]); },
  function () { return Object.create(new String('pq')); },
];
var r = [];
targets.forEach(function (mk, ti) {
  for (var n = 0; n <= 5; n++) {
    try {
      r.push(ti + ':' + n + '=' + Array.from(Array.prototype.values.call(wrap(mk(), n))).map(String).join('.') +
        '/' + Array.from(Array.prototype.keys.call(wrap(mk(), n))).length);
    } catch (e) { r.push(ti + ':' + n + '!' + e.name); }
  }
});
r.join('|')
// ---
// A3 review: wide primitive and number wrappers with an inherited length and indexes, reached
// through 0..4 forwarding layers and through a trapped layer at each position.
Symbol.prototype.length = 2; Symbol.prototype[0] = 'sa'; Symbol.prototype[1] = 'sb';
BigInt.prototype.length = 1; BigInt.prototype[0] = 'big';
Number.prototype.length = 2; Number.prototype[1] = 'n1';
Boolean.prototype.length = 1; Boolean.prototype[0] = 'b0';
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var mks = [function () { return Object(Symbol()); }, function () { return Object(1n); },
  function () { return Object(3); }, function () { return Object(false); }];
var r = [];
mks.forEach(function (mk) {
  for (var n = 0; n <= 4; n++) {
    r.push(Array.from(Array.prototype.values.call(wrap(mk(), n))).join());
    for (var at = 0; at <= n; at++) {
      var o = wrap(new Proxy(wrap(mk(), at), RG), n - at);
      r.push(Array.from(Array.prototype.entries.call(o)).join(';'));
    }
  }
});
r.join('|')
// ---
// A3 review: a logging get trap at every (below, above) position over an array, a String wrapper
// and an array-like, read by spread, for-of, Array.from and keys().
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
function trapLayer(o) {
  return new Proxy(o, { get: function (t, k, rr) { log.push(typeof k === 'symbol' ? 'sym' : k); return Reflect.get(t, k, rr); } });
}
var mks = [function () { return [10, 20]; }, function () { return new String('xy'); },
  function () { return { length: 2, 0: 'p', 1: 'q' }; }];
var r = [];
mks.forEach(function (mk, mi) {
  for (var below = 0; below <= 3; below++) for (var above = 0; above <= 3; above++) {
    log = [];
    var p = wrap(trapLayer(wrap(mk(), below)), above);
    var out = [];
    for (var v of Array.prototype.values.call(p)) out.push(v);
    out.push(Array.from(Array.prototype.keys.call(p)).join(''));
    if (mi !== 2) out.push([...p].join(':'));
    r.push(mi + '/' + below + '/' + above + '=' + out.join(',') + '#' + log.join(','));
  }
});
r.join('|')
// ---
// A3 review: get traps that read their target in every way (Reflect.get with and without the
// receiver, t[k], a different key, the same key twice, Reflect.get on a different proxy), so the
// active-trap context matches, mismatches, and is consumed.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var other = wrap([7, 8, 9], 2);
var handlers = [
  { get: function (t, k, r) { return Reflect.get(t, k, r); } },
  { get: function (t, k) { return Reflect.get(t, k); } },
  { get: function (t, k) { return t[k]; } },
  { get: function (t, k, r) { Reflect.get(t, 'length', r); return Reflect.get(t, k, r); } },
  { get: function (t, k, r) { Reflect.get(t, k, r); return Reflect.get(t, k, r); } },
  { get: function (t, k, r) { return k === 'length' ? Reflect.get(other, k) : Reflect.get(t, k, r); } },
  { get: function (t, k, r) { return Reflect.get(t, k, t); } },
  { get: function (t, k, r) { var v = Reflect.get(t, k, r); return typeof v === 'number' ? v + 1 : v; } },
  { get: function (t, k, r) { return Reflect.get(wrap(t, 2), k, r); } },
  { get: function (t, k, r) { if (k === '1') [...wrap([1, 2, 3], 2)]; return Reflect.get(t, k, r); } },
  { inner: 0, get: function (t, k, r) { if (k === '0' && this.inner < 3) { this.inner++; Array.from(Array.prototype.values.call(new Proxy(t, this))); this.inner--; } return Reflect.get(t, k, r); } },
];
var mks = [function () { return [1, 2]; }, function () { return new String('ab'); },
  function () { return { length: 2, 0: 'o', 1: 'p' }; }, function () { return Object(Symbol('w')); }];
var r = [];
handlers.forEach(function (h, hi) {
  mks.forEach(function (mk, mi) {
    for (var depth = 0; depth <= 3; depth++) {
      try {
        var p = new Proxy(wrap(mk(), depth), h);
        r.push(hi + '.' + mi + '.' + depth + '=' + Array.from(Array.prototype.values.call(wrap(p, 1))).map(String).join(':') +
          '/' + Array.from(Array.prototype.values.call(p)).length);
      } catch (e) { r.push(hi + '.' + mi + '.' + depth + '!' + e.name); }
    }
  });
});
r.join('|')
// ---
// A3 review: two and three trapped layers, each reading through Reflect.get, separated by
// trap-absent layers, over each terminal (the forwarded flag on at a trapped layer, the active
// context at each).
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var calls = 0;
var RG = { get: function (t, k, r) { calls++; return Reflect.get(t, k, r); } };
var TK = { get: function (t, k) { calls++; return t[k]; } };
var mks = [function () { return [1, 2, 3]; }, function () { return new String('abc'); },
  function () { return { length: 3, 0: 'x', 1: 'y', 2: 'z' }; }, function () { return Object(2n); },
  function () { return new Int32Array([5, 6]); }];
var r = [];
mks.forEach(function (mk, mi) {
  for (var a = 0; a <= 2; a++) for (var b = 0; b <= 2; b++) for (var c = 0; c <= 2; c++) {
    calls = 0;
    var p = wrap(new Proxy(wrap(new Proxy(wrap(mk(), c), RG), b), (a + b) % 2 ? TK : RG), a);
    var q = new Proxy(wrap(new Proxy(wrap(new Proxy(wrap(mk(), c), RG), b), TK), a), RG);
    try {
      r.push(mi + a + b + c + '=' + Array.from(Array.prototype.values.call(p)).length + '/' +
        Array.from(Array.prototype.entries.call(q)).length + '#' + calls);
    } catch (e) { r.push(mi + a + b + c + '!' + e.name + '#' + calls); }
  }
});
r.join('|')
// ---
// A3 review: revoked proxies at every depth of the iterated chain, revoked between next() calls,
// revoked by the trap itself, and as the trap's own target.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var r = [];
function tryit(f) { try { r.push(String(f())); } catch (e) { r.push(e.name); } }
for (var n = 0; n <= 3; n++) {
  for (var m = 0; m <= 2; m++) {
    var rv = Proxy.revocable(wrap([1, 2], m), {});
    rv.revoke();
    var p = wrap(rv.proxy, n);
    tryit(function () { return JSON.stringify(Array.prototype.values.call(p).next()); });
    tryit(function () { return Array.from(Array.prototype.keys.call(p)).length; });
    var rt = Proxy.revocable(wrap(new String('ab'), m), { get: function (t, k, rr) { return Reflect.get(t, k, rr); } });
    var pt = wrap(rt.proxy, n);
    tryit(function () { return Array.from(Array.prototype.values.call(pt)).join(); });
    rt.revoke();
    tryit(function () { return Array.from(Array.prototype.values.call(pt)).join(); });
  }
}
var rv2 = Proxy.revocable([1, 2, 3], {});
var it = Array.prototype.values.call(wrap(rv2.proxy, 2));
r.push(it.next().value);
rv2.revoke();
tryit(function () { return it.next().value; });
tryit(function () { return it.next().done; });
var rv3 = Proxy.revocable([5, 6, 7], {});
var p3 = new Proxy(wrap(rv3.proxy, 1), { get: function (t, k, rr) { if (k === '1') rv3.revoke(); return Reflect.get(t, k, rr); } });
tryit(function () { return Array.from(Array.prototype.values.call(wrap(p3, 2))).join(); });
var rv4 = Proxy.revocable([1], {});
var p4 = new Proxy(rv4.proxy, { get: function (t, k, rr) { rv4.revoke(); return Reflect.get(t, k, rr); } });
tryit(function () { return Array.from(Array.prototype.values.call(p4)).join(); });
r.join('|')
// ---
// A3 review: getters on the target and on its prototypes, observing the receiver, one of which
// iterates another proxied array (a nested Array Iterator under an outer one).
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var log = [];
var proto = { get 1() { log.push('p1:' + (this === top)); return 'one'; } };
var t = Object.create(proto, {
  length: { get: function () { log.push('len:' + (this === top)); return 4; } },
  0: { get: function () { return 'z' + (this === top); } },
  2: { get: function () { return [...wrap([this === top, 'n'], 2)].join('&'); } },
  3: { get: function () { return Array.from(Array.prototype.values.call(wrap(new String('st'), 3))).join(''); } },
});
var top = wrap(t, 3);
var a = Array.from(Array.prototype.values.call(top));
var trapped = new Proxy(wrap(t, 2), { get: function (tt, k, rr) { log.push('trap:' + String(k)); return Reflect.get(tt, k, rr); } });
top = wrap(trapped, 1);
var b = Array.from(Array.prototype.values.call(top));
[a.join(','), b.join(','), log.join()].join('|')
// ---
// A3 review: invariant violations reached by the Array Iterator through forwarding layers.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var r = [];
function tryit(f) { try { r.push(String(f())); } catch (e) { r.push(e.name + ':' + e.message); } }
for (var n = 0; n <= 2; n++) for (var m = 0; m <= 2; m++) {
  var frozen = Object.freeze([1, 2]);
  var lie = wrap(new Proxy(wrap(frozen, m), { get: function (t, k, rr) { return k === '1' ? 99 : Reflect.get(t, k, rr); } }), n);
  tryit(function () { return Array.from(Array.prototype.values.call(lie)).join(); });
  var acc = Object.defineProperty({ length: 1 }, 0, { set: function () {}, configurable: false });
  var lie2 = wrap(new Proxy(wrap(acc, m), { get: function () { return 1; } }), n);
  tryit(function () { return Array.from(Array.prototype.values.call(lie2)).join(); });
  var fs = Object.freeze(new String('fz'));
  var lie3 = wrap(new Proxy(wrap(fs, m), { get: function (t, k, rr) { return k === '0' ? 'Q' : Reflect.get(t, k, rr); } }), n);
  tryit(function () { return Array.from(Array.prototype.values.call(lie3)).join(); });
}
r.join('|')
// ---
// A3 review: traps that throw at each position of an Array.from / spread / destructuring walk
// (iterator close), and length traps returning hostile values.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var r = [];
function tryit(f) { try { r.push(String(f())); } catch (e) { r.push(e.name + ':' + e.message); } }
['length', '0', '1', '2'].forEach(function (bad) {
  var p = wrap(new Proxy(wrap([1, 2, 3], 2), { get: function (t, k, rr) { if (k === bad) throw new RangeError(bad); return Reflect.get(t, k, rr); } }), 2);
  tryit(function () { return Array.from(Array.prototype.values.call(p)).join(); });
  tryit(function () { return [...Array.prototype.values.call(p)].join(); });
  tryit(function () { var [x, y, z] = Array.prototype.values.call(p); return x + y + z; });
});
var lens = [-1, NaN, 2.7, '2', { valueOf: function () { return 2; } }, Infinity, 2 ** 53 + 5, 4294967297, undefined, null, true];
lens.forEach(function (len) {
  var p = wrap(new Proxy(wrap({ 0: 'a', 1: 'b' }, 1), { get: function (t, k, rr) { return k === 'length' ? len : Reflect.get(t, k, rr); } }), 1);
  tryit(function () { var it = Array.prototype.values.call(p); return JSON.stringify([it.next(), it.next(), it.next()]); });
});
tryit(function () { return Array.prototype.values.call(wrap({ length: { valueOf: function () { throw new TypeError('vo'); } } }, 3)).next(); });
r.join('|')
// ---
// A3 review: proxies on the prototype chain of an ordinary (non-proxy) iterated object, with and
// without traps, and the String-wrapper / array prototypes.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var r = [];
for (var n = 0; n <= 3; n++) {
  var o1 = Object.create(wrap([1, 2, 3], n));
  var o2 = Object.create(new Proxy(wrap(new String('ab'), n), RG));
  var o3 = Object.create(wrap({ length: 2, 1: 'one' }, n)); o3[0] = 'zero';
  var o4 = Object.setPrototypeOf([9, , 9], wrap(Object.setPrototypeOf({ 1: 'hole' }, Array.prototype), n));
  r.push([o1, o2, o3, o4].map(function (o) { return Array.from(Array.prototype.values.call(o)).join(':'); }).join(','));
  r.push(Array.from(Array.prototype.values.call(wrap(o4, n))).join(':'));
}
r.join('|')
// ---
// A3 review: sparse arrays and high indexes behind proxies (index keys with no interned name),
// typed arrays, and an array whose holes are answered by a proxied prototype.
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var a = []; a[2999] = 'last'; a[1500] = 'mid';
var b = [1, , 3]; Object.setPrototypeOf(b, wrap(Object.setPrototypeOf({ 1: 'fromproto' }, Array.prototype), 3));
var big = { length: 4294967297, 0: 'a', 4294967295: 'top' };
var r = [];
for (var n = 0; n <= 3; n++) {
  var arr = Array.from(Array.prototype.values.call(wrap(a, n)));
  r.push(arr.length, arr[2999], arr[1500], arr.filter(function (x) { return x !== undefined; }).length);
  r.push(Array.from(Array.prototype.values.call(wrap(b, n))).join());
  r.push(Array.from(Array.prototype.values.call(new Proxy(wrap(b, n), { get: function (t, k, rr) { return Reflect.get(t, k, rr); } }))).join());
  var it = Array.prototype.values.call(wrap(big, n)); r.push(it.next().value, it.next().value);
  try { r.push(Array.from(Array.prototype.values.call(wrap(new Uint16Array([1, 2, 65535]), n))).join()); } catch (e) { r.push(e.name); }
  try { r.push(Array.from(Array.prototype.values.call(Object.create(wrap(new Uint16Array([1, 2, 65535]), n)))).join()); } catch (e) { r.push(e.name); }
  var ta = new Uint16Array([4, 5]); Object.defineProperty(ta, 'length', { value: 2 });
  r.push(Array.from(Array.prototype.values.call(wrap(ta, n))).join());
}
r.join('|')
// ---
// A3 review: Proxy prototype cycles under the Array Iterator (a hole read walks the cycle until
// the reentry limit) - the halt and its depth must match.
var t = [1, , 3];
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review: the cycle's first element is answered before the cycle is walked.
var t = { length: 2, 0: 'a' };
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
var it = Array.prototype.values.call(p);
[it.next().value, Array.prototype.keys.call(p).next().value].join()
// ---
// A3 review: a cycle read by a named key.
var t = { length: 2, 0: 'a' };
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
p.zzz
// ---
// A3 review: a cycle read by an index key.
var t = { length: 2, 0: 'a' };
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
p[5]
// ---
// A3 review: a cycle read by Reflect.get with a foreign receiver.
var t = { length: 2, 0: 'a' };
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
Reflect.get(p, 'q', {})
// ---
// A3 review: a cycle read by the iterator through an array-like (halts or throws).
var t = { length: 2, 0: 'a' };
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review: a cycle through a trapped proxy whose trap reads through Reflect.get.
var t = [1, , 3];
var p = new Proxy(t, { get: function (tt, k, r) { return Reflect.get(tt, k, r); } });
Object.setPrototypeOf(t, p);
Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review: a cycle through a String wrapper.
var t = new String('ab');
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
var r = [Array.from(Array.prototype.values.call(p)).join()];
r.push(p[7]);
r.join()
// ---
// A3 review: a two-proxy cycle with one trapped layer.
var t = [0, , 2];
var q = new Proxy(new Proxy(t, {}), { get: function (tt, k, r) { return Reflect.get(tt, k, r); } });
Object.setPrototypeOf(t, new Proxy(q, {}));
Array.from(Array.prototype.values.call(q)).join()
