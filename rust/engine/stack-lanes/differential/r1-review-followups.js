// Review follow-ups to Phase 1: the forwarding walks on one loop, the depth
// restore of the explicit-stack walks, and the apply trap's argument list.
// Consecutive apply-trap turns: each trap is itself a Proxy whose apply trap
// forwards, so every turn rebuilds the argument list, ending at a bound target.
function target(a, b) { return [this && this.tag, a, b].join(':'); }
var f = target.bind({ tag: 'bound' }, 'x');
for (var i = 0; i < 10; i++) {
  f = new Proxy(f, {
    apply: new Proxy(function (t, self, args) { return Reflect.apply(t, self, args); }, {
      apply: function (t, self, args) { return Reflect.apply(t, self, args); },
    }),
  });
}
[f('y'), f.call(null, 'z'), f.apply(null, ['w'])].join('|')
// ---
// Apply-trap turns until the budget halts: a chain of trap-is-a-Proxy layers.
var g = function () { return 1; };
for (var i = 0; i < 3000; i++) {
  g = new Proxy(g, { apply: new Proxy(function (t, s, a) { return Reflect.apply(t, s, a); }, {}) });
}
g()
// ---
// A JSON.parse that fails deep inside its nest leaves no units charged: a parse
// at the walker's ceiling (jparse-arr, 2,016) afterwards still succeeds.
var failed = 0;
for (var i = 0; i < 4; i++) {
  try { JSON.parse('['.repeat(1000) + '1,'); } catch (e) { failed++; }
}
[failed, JSON.parse('['.repeat(2016) + ']'.repeat(2016)).length].join()
// ---
// As above for JSON.stringify failing in a toJSON at the bottom of a nest,
// then a nest at the ceiling (jstr-arr, 2,014).
function nested(depth, bottom) {
  var a = []; var r = a;
  for (var i = 0; i < depth; i++) { var b = []; r[0] = b; r = b; }
  if (bottom) r[0] = bottom;
  return a;
}
var throwing = nested(1000, { toJSON: function () { throw new Error('bottom'); } });
var failed = 0;
for (var i = 0; i < 4; i++) { try { JSON.stringify(throwing); } catch (e) { failed++; } }
[failed, JSON.stringify(nested(2014)).length].join()
// ---
// As above for a reviver that throws at the deepest value, then a reviver
// over a nest at the ceiling (jrevive-arr, 2,000).
var failed = 0;
for (var i = 0; i < 4; i++) {
  try {
    JSON.parse('['.repeat(1000) + '1' + ']'.repeat(1000),
      function (k, x) { if (x === 1) throw new Error('deep'); return x; });
  } catch (e) { failed++; }
}
[failed, JSON.parse('['.repeat(2000) + ']'.repeat(2000), function (k, x) { return x; }).length].join()
// ---
// As above for the generic flat path failing in a getter at the bottom of a
// sparse nest, then a sparse nest at the ceiling (flat-generic, 2,015).
function sparse(depth) {
  var a = []; var r = a;
  for (var i = 0; i < depth; i++) { var b = []; r[1] = b; r = b; }
  return { top: a, bottom: r };
}
var failing = sparse(1000);
Object.defineProperty(failing.bottom, 1, { get: function () { throw new Error('getter'); } });
var failed = 0;
for (var i = 0; i < 4; i++) { try { failing.top.flat(Infinity); } catch (e) { failed++; } }
[failed, sparse(2015).top.flat(Infinity).length].join()
// ---
// [[HasProperty]] and the index-keyed walks through Proxy, ordinary, Proxy
// layers ending at a trap, with an id key and an index the name table never held.
var log = [];
var end = new Proxy({ 7: 'seven' }, {
  has: function (t, k) { log.push('has:' + k); return k in t; },
  get: function (t, k, r) { log.push('get:' + String(k)); return Reflect.get(t, k, r); },
});
var p = end;
for (var i = 0; i < 12; i++) p = i % 3 ? new Proxy(p, {}) : Object.create(p);
[('x' in p), (923456787 in p), p[923456787], (7 in p), p[7], log.join(',')].join('|')
