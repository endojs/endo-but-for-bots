// B9: an id-keyed [[Get]] or [[Set]] that crosses between ordinary objects and Proxies runs
// as one loop, charging each crossing the unit its guarded entry charged. The halts below sit
// on both sides of each entry's ceiling: the opcode, the computed key, Reflect, super, and the
// assignment forms.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = [];
var p = alt({ x: 1 }, 2031);
r.push(p.x);
var k = 'x';
p = alt({ x: 2 }, 2032);
r.push(p[k]);
p = alt({ x: 3 }, 2015);
r.push(Reflect.get(p, 'x'));
p = alt({}, 2030);
p.zz = 4;
r.push(p.zz);
p = alt({}, 2030);
p[k] = 5;
r.push(Object.keys(p).length);
r.join()
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
alt({ x: 1 }, 2032).x
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var k = 'x';
alt({ x: 1 }, 2033)[k]
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
Reflect.get(alt({ x: 1 }, 2016), 'x')
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
alt({}, 2031).zz = 1
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var k = 'zz';
alt({}, 2031)[k] = 1
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
Reflect.set(alt({}, 2015), 'zz', 1)
// ---
// The prototype cycle through a Proxy, from each side and for each form: every lap is two
// units, and the halt comes at the same depth and meter.
var t = {};
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
p.zzz = 1
// ---
var t = {};
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
Reflect.set(t, 'zzz', 1, {})
// ---
var t = {};
var p = new Proxy(t, {});
Object.setPrototypeOf(t, p);
Reflect.get(p, 'zzz', 5)
// ---
var t = {};
var p = new Proxy(new Proxy(t, {}), {});
Object.setPrototypeOf(t, p);
var k = 'zzz';
t[k]
// ---
// A super read and assignment through an alternating chain.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var base = alt({ m: 7, get g() { return this.tag; } }, 41);
var o = { tag: 't', read() { return [super.m, super.g].join(); }, write() { super.w = 9; return this.w; } };
Object.setPrototypeOf(o, base);
[o.read(), o.write(), Object.keys(o).join()].join('|')
// ---
// The terminal object at the end of the crossings is exotic: an array's length and items, a
// function's name and prototype, a TypedArray's element, a String wrapper's units.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = [];
var a = alt([5, 6, 7], 9);
r.push(a.length, a[1], a['2']);
function named() {}
var f = alt(named, 9);
r.push(f.name, typeof f.prototype, f.length);
var ta = alt(new Uint8Array([9, 8]), 9);
r.push(ta[1], ta['0'], ta['-0'], ta[5]);
var s = alt(new String('hey'), 9);
r.push(s[1], s.length);
r.join()
// ---
// Assignments that end at exotic objects past the crossings: a TypedArray element on the chain
// (the receiver is not the TypedArray, so it is created on the receiver only if the index is
// valid), an array's length through a Proxy, and a String wrapper's read-only index.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = [];
var ta = new Uint8Array(2);
var c = alt(ta, 8);
c[1] = 200;
c[7] = 3;
r.push(ta[1], Object.keys(c).join(':'), c['1'], c[7]);
var arr = [1, 2, 3];
var ca = alt(arr, 7);
ca.length = 1;
r.push(arr.length, Object.keys(ca).join(':'));
var s = alt(new String('ab'), 8);
s[0] = 'z';
s.q = 1;
r.push(s[0], s.q, Object.keys(s).join(':'));
r.join('|')
// ---
// Getters and setters reached past crossings run with every unit held: a nest under them
// reaches the budget at the same depth.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var depth = 0;
var log = [];
var g = alt({ get v() { depth++; try { return deep(); } finally { depth--; } }, set v(x) { log.push(x); try { deep(); } catch (e) { log.push(e.name); } } }, 401);
function deep() { var o = alt({ v: 1 }, 1201); return o.v; }
var r = [];
try { r.push(g.v); } catch (e) { r.push('get:' + e.name); }
g.v = 3;
r.push(log.join(), depth);
r.join('|')
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var g = alt({ get v() { return alt({ w: 2 }, 1615).w; } }, 401);
g.v
// ---
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var g = alt({ get v() { return alt({ w: 2 }, 1616).w; } }, 401);
g.v
// ---
// Trapped layers in the middle and at the end of the crossings: the trap reads further down the
// chain, or answers itself, and the set trap's result decides the assignment.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var log = [];
var bottom = alt({ x: 'b', y: 'yb' }, 21);
var mid = new Proxy(bottom, {
  get: function (t, k, r) { log.push('get:' + String(k)); return k === 'y' ? 'trap' : Reflect.get(t, k, r); },
  set: function (t, k, v, r) { log.push('set:' + String(k)); return k === 'ro' ? false : Reflect.set(t, k, v, r); },
});
var top = alt(mid, 21);
var r = [top.x, top.y, top.nope];
top.w = 1;
top.ro = 2;
r.push(top.w, top.ro, Object.keys(top).join(':'));
(function () { 'use strict'; try { top.ro = 3; r.push('no throw'); } catch (e) { r.push(e.name); } })();
r.push(log.join());
r.join('|')
// ---
// Throws from a trap, a getter, a setter and a revoked Proxy past crossings release every unit:
// the next read reaches the same ceiling.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = [];
var rev = Proxy.revocable({}, {});
rev.revoke();
var throwers = [
  alt(new Proxy({}, { get: function () { throw 'trap'; } }), 33),
  alt({ get x() { throw 'getter'; } }, 33),
  alt(rev.proxy, 33),
];
for (var j = 0; j < 3; j++) {
  for (var i = 0; i < 50; i++) { try { throwers[j].x; } catch (e) { if (i === 0) r.push(typeof e === 'string' ? e : e.name); } }
}
var setters = [
  alt(new Proxy({}, { set: function () { throw 'strap'; } }), 33),
  alt({ set x(v) { throw 'setter'; } }, 33),
  alt(rev.proxy, 34),
];
for (var j = 0; j < 3; j++) {
  for (var i = 0; i < 50; i++) { try { setters[j].x = 1; } catch (e) { if (i === 0) r.push(typeof e === 'string' ? e : e.name); } }
}
r.push(alt({ x: 'after' }, 2031).x);
r.join()
// ---
// A Proxy receiver at the end of an assignment's crossings: the receiver's own property is read
// and defined through its traps, with every unit held.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var log = [];
var recv = new Proxy({}, {
  getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + k); return Reflect.getOwnPropertyDescriptor(t, k); },
  defineProperty: function (t, k, d) { log.push('define:' + k); return Reflect.defineProperty(t, k, d); },
});
var chain = alt({}, 30);
var ok = Reflect.set(chain, 'a', 1, recv);
var ok2 = Reflect.set(alt(recv, 30), 'b', 2);
[ok, ok2, Object.keys(recv).join(':'), log.join()].join('|')
// ---
// The Array Iterator reads through alternating chains: its get trap's residual context aimed at
// an object reached past crossings, by name and by index, over arrays and a String wrapper.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var r = [];
var targets = [[1, 2, 3], { length: 2, 0: 'p', 1: 'q' }, new String('st')];
for (var j = 0; j < targets.length; j++) {
  var inner = new Proxy(targets[j], {});
  var chain = alt(Object.create(inner), 6);
  var top = new Proxy(inner, { get: function (t, k, rcv) { return Reflect.get(chain, k, rcv); } });
  r.push(Array.from(Array.prototype.values.call(top)).join(':'));
  r.push(Array.prototype.join.call(alt(top, 5), '-'));
}
r.join('|')
// ---
// Symbols, the with statement and a for-in over alternating chains.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var sym = Symbol('s');
var base = { a: 1 };
base[sym] = 'sym';
var c = alt(base, 17);
var r = [c[sym]];
c[sym] = 'own';
r.push(c[sym], base[sym]);
with (alt({ wv: 'with' }, 11)) { r.push(wv); }
var keys = [];
for (var key in alt({ e1: 1, e2: 2 }, 6)) keys.push(key);
r.push(keys.join(':'));
r.join('|')
// ---
// Non-writable and setter-less properties past crossings refuse the assignment, silently in
// sloppy code and with a TypeError in strict code.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var base = {};
Object.defineProperty(base, 'ro', { value: 1, writable: false });
Object.defineProperty(base, 'getOnly', { get: function () { return 'g'; } });
var c = alt(base, 13);
var r = [];
c.ro = 2;
c.getOnly = 3;
r.push(c.ro, c.getOnly, Object.keys(c).length);
(function () {
  'use strict';
  try { c.ro = 4; } catch (e) { r.push(e.name); }
  try { c.getOnly = 5; } catch (e) { r.push(e.name); }
})();
r.join()
// ---
// Keys that are canonical numeric strings but not array indices are id-keyed, so a TypedArray
// past crossings answers them as its element through the loop: an assignment to an invalid
// element is ignored (never created on the receiver), a read gives undefined, whichever Proxy
// or ordinary object the chain reaches it through.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var keys = ['-0', '1.5', '1e3', 'NaN', '-1', 'Infinity', '0x1'];
var r = [];
for (var depth = 1; depth < 6; depth++) {
  var ta = new Float64Array(2);
  var c = alt(ta, depth);
  for (var j = 0; j < keys.length; j++) {
    var k = keys[j];
    c[k] = 7;
    r.push(Object.prototype.hasOwnProperty.call(c, k) ? 'own' : 'none', String(c[k]));
    r.push(Reflect.set(c, k, 8, {}), Reflect.set(c, k, 9, ta));
  }
  r.push(Object.keys(c).join(':'), ta.join(':'));
}
r.join(',')
// ---
// The same keys on a TypedArray whose own prototype chain alternates: a key that names no element
// walks on from the TypedArray to a setter past a Proxy, and a BigInt array checks its value.
function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; }
var log = [];
var base = { set zz(v) { log.push('zz=' + v); }, set '-0'(v) { log.push('never'); } };
var ta = new BigInt64Array(1);
Object.setPrototypeOf(ta, alt(base, 5));
var top = alt(ta, 4);
top.zz = 1;
try { top['-0'] = 5n; top['1.5'] = 2; } catch (e) { log.push(e.name); }
Reflect.set(top, 'zz', 3, {});
[log.join(), Object.keys(top).join(':')].join('|')
