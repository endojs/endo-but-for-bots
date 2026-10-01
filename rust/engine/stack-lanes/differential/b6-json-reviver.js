// B6: the reviver walk with an explicit stack. Call order, holders, keys and source context
// across mixed nesting, with replaced, deleted and kept values.
var log = [];
var text = '{"a":[1,{"b":"two","c":[true,null,3.5]}],"d":{"e":{"f":-0,"g":[[]]}},"h":"\\u0041"}';
var v = JSON.parse(text, function (k, val, ctx) {
  var src = ctx && Object.prototype.hasOwnProperty.call(ctx, 'source') ? ctx.source : '-';
  log.push((Array.isArray(this) ? 'A' : 'O') + ':' + k + '=' + src);
  if (k === 'b') return undefined;
  if (k === 'e') return [val];
  if (typeof val === 'number' && k === '0') return val * 10;
  return val;
});
[JSON.stringify(v), log.join(' ')].join(' | ')
// ---
// Mutation by the reviver: a later sibling replaced (its source is then withheld), a later
// sibling deleted, a property added to the holder, and an array grown and shrunk mid-walk.
var log = [];
var v = JSON.parse('{"a":1,"b":2,"c":{"x":3},"arr":[10,20,30,40],"z":"end"}', function (k, val, ctx) {
  log.push(k + ':' + JSON.stringify(val) + ':' + ('source' in ctx ? ctx.source : '-'));
  if (k === 'a') { this.b = 'replaced'; delete this.c; this.added = 'new'; }
  if (k === '0' && Array.isArray(this)) { this.push(50); this.length = 3; }
  return val;
});
[JSON.stringify(v), log.join(' ')].join(' | ')
// ---
// Repeated keys (only the last value is walked, with its source), index keys in objects, and
// keys that the reviver names while the walk runs.
var log = [];
var v = JSON.parse('{"k":1,"k":{"k":[1,2],"k":[3]},"0":"zero","7":{"8":[9]},"4294967295":"big"}', function (k, val, ctx) {
  log.push(k + '/' + ('source' in ctx ? ctx.source : '-'));
  if (k === '0') this[1] = 'one';
  return val;
});
[JSON.stringify(v), log.join(' ')].join(' | ')
// ---
// Holders replaced by Proxies and accessors mid-walk: the walk reads children through them.
var log = [];
var v = JSON.parse('{"p":{"q":{"r":1}},"s":[1,2]}', function (k, val) {
  log.push(k);
  if (k === 'r') return 2;
  if (k === 'q') {
    return new Proxy(val, { get: function (t, key, rcv) { log.push('get:' + String(key)); return Reflect.get(t, key, rcv); } });
  }
  return val;
});
var w = JSON.parse('[[1,[2]],[3]]', function (k, val) {
  if (k === '0' && Array.isArray(val) && val.length === 2) {
    Object.defineProperty(this, '1', { get: function () { log.push('getter'); return [7, [8]]; }, configurable: true });
  }
  return val;
});
[JSON.stringify(v), JSON.stringify(w), log.join(',')].join(' | ')
// ---
// Revived values that cannot be written back: a non-configurable, non-writable property on
// the holder (CreateDataProperty returns false, silently), and a frozen holder.
var v = JSON.parse('{"a":{"b":1,"c":2},"d":[1,2]}', function (k, val) {
  if (k === 'b') { Object.defineProperty(this, 'c', { value: 'fixed', writable: false, configurable: false }); return 'B'; }
  if (k === 'c') return 'C';
  if (k === '0') { Object.freeze(this); return 'zero'; }
  return val;
});
JSON.stringify(v)
// ---
// Deep nests revived below the ceiling, arrays and objects, each element revived.
var r = [];
for (var d = 1940; d <= 1972; d += 4) {
  var calls = 0;
  JSON.parse('['.repeat(d) + '1' + ']'.repeat(d), function (k, val) { calls++; return val; });
  r.push(d + ':' + calls);
}
for (var d = 1940; d <= 1968; d += 4) {
  var calls = 0;
  JSON.parse('{"a":'.repeat(d) + '{}' + '}'.repeat(d), function (k, val) { calls++; return val; });
  r.push(d + ':' + calls);
}
r.join()
// ---
// One past the reviver's ceiling halts.
JSON.parse('['.repeat(2000) + '1' + ']'.repeat(2000), function (k, v) { return v; });
// ---
// A reviver that throws at every depth; the walk unwinds, and a revive at the ceiling still
// completes afterwards (the exact ceiling pairs are among the review's programs below).
var r = [];
for (var d = 1; d < 950; d += 75) {
  try {
    JSON.parse('[{"a":'.repeat(d) + '"x"' + '}]'.repeat(d), function (k, val) { if (val === 'x') throw new RangeError('d' + d); return val; });
  } catch (e) { r.push(e.message); }
}
var calls = 0;
JSON.parse('['.repeat(1940) + ']'.repeat(1940), function (k, val) { calls++; return val; });
r.push(calls);
r.join()
// ---
// The reviver re-enters JSON.parse with its own reviver at depth.
var log = [];
var v = JSON.parse('{"a":[{"b":"[1,[2,{\\"c\\":3}]]"}]}', function (k, val) {
  if (k === 'b') {
    return JSON.parse(val, function (k2, v2, ctx) { log.push('inner:' + k2 + ':' + ('source' in ctx ? ctx.source : '-')); return v2; });
  }
  log.push('outer:' + k);
  return val;
});
[JSON.stringify(v), log.join(' ')].join(' | ')
// ---
// A wide revive: many siblings at several levels, with every tenth one deleted.
var parts = [];
for (var i = 0; i < 3000; i++) parts.push('{"i":' + i + ',"v":[' + i + ',"s' + i + '"]}');
var n = 0;
var v = JSON.parse('{"rows":[' + parts.join(',') + '],"tail":[[[[1]]]]}', function (k, val) {
  n++;
  if (k === 'i' && val % 10 === 0) return undefined;
  return val;
});
[n, v.rows.length, Object.keys(v.rows[0]).join('+'), v.rows[1].i, JSON.stringify(v.tail)].join()

// ---
// From the pre-commit review: index keys named mid-walk: an accessor defined on a later index promotes it to a
// name. Pins today's behavior: the child's Get uses the snapshot key (so the promoted "2" reads
// undefined and is deleted), the write-back refreshes it, and the source map keyed at entry
// misses a key named later ("5" loses its source). Node gives 2=30 and 5=50:50.
var log = [];
var v = JSON.parse('{"0":10,"1":{"2":[20,21]},"2":30,"3":"s","x":{"4":40,"5":50}}', function (k, val, ctx) {
  log.push(k + '=' + JSON.stringify(val) + ':' + ('source' in ctx ? ctx.source : '-') + ':' + Object.keys(this).join('+'));
  if (k === '0') Object.defineProperty(this, '2', { get: function () { log.push('get2'); return 30; }, enumerable: true, configurable: true });
  if (k === '4') { Object.defineProperty(this, '5', { value: 50, writable: true, enumerable: true, configurable: true }); this[9] = 'nine'; }
  if (k === '20') this[1] = 'x';
  return val;
});
[JSON.stringify(v), log.join(' ')].join(' | ')
// ---
// B6 extra: arrays grown and shrunk mid-walk (the length is snapshotted), holes created by
// returning undefined, and elements replaced by SameValue-equal and unequal values (-0 vs 0).
var log = [];
var v = JSON.parse('[[1,2,3,4],[-0,0,"a",true,null],{"n":-0,"m":0}]', function (k, val, ctx) {
  log.push(k + ':' + (Object.is(val, -0) ? '-0' : JSON.stringify(val)) + ':' + ('source' in ctx ? ctx.source : '-'));
  if (Array.isArray(this) && k === '0' && val === 1) { this.length = 2; this.push('p'); }
  if (Array.isArray(this) && k === '0' && Object.is(val, -0)) { this[1] = -0; this[2] = 'a'; this[3] = false; this[4] = null; }
  if (k === 'n') this.m = -0;
  if (k === '1' && val === 2) return undefined;
  return val;
});
[JSON.stringify(v), v[0].length, 1 in v[0], log.join(' ')].join(' | ')
// ---
// B6 extra: a later sibling replaced by Proxies (object and array) whose every trap is logged:
// the walk's Get, IsArray, length, ownKeys, getOwnPropertyDescriptor, defineProperty and
// deleteProperty all go through them, in order.
var log = [];
function P(t, tag) {
  return new Proxy(t, {
    get: function (t, k, r) { log.push(tag + '.get:' + String(k)); return Reflect.get(t, k, r); },
    ownKeys: function (t) { log.push(tag + '.keys'); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor: function (t, k) { log.push(tag + '.gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
    defineProperty: function (t, k, d) { log.push(tag + '.def:' + String(k) + '=' + JSON.stringify(d.value)); return Reflect.defineProperty(t, k, d); },
    deleteProperty: function (t, k) { log.push(tag + '.del:' + String(k)); return Reflect.deleteProperty(t, k); },
  });
}
var v = JSON.parse('{"a":1,"b":{"c":2,"d":[3,4]},"e":[5,{"f":6}]}', function (k, val) {
  log.push('rev:' + k);
  if (k === 'a') { this.b = P({ c: 'C', d: P([3, 4, 5], 'pd'), g: 'G' }, 'pb'); this.e = P([P({ f: 'F' }, 'pf'), 7], 'pe'); }
  if (k === 'g' || k === '1') return undefined;
  if (typeof val === 'string') return val + val;
  return val;
});
[JSON.stringify(v), log.join(',')].join(' | ')
// ---
// B6 extra: holders and `this`: every call's receiver is the object that holds the key, through
// replaced containers, and the root holder is a fresh wrapper with one own key.
var log = [];
var root;
var v = JSON.parse('{"a":{"b":[{"c":1}]},"d":2}', function (k, val) {
  if (k === '') { root = this; log.push('root:' + Object.keys(this).join('+') + ':' + (Object.getPrototypeOf(this) === Object.prototype)); }
  else log.push(k + ':' + (Array.isArray(this) ? 'A' + this.length : Object.keys(this).join('+')));
  if (k === 'c') { this.added = 'x'; return [val]; }
  if (k === '0') return { wrapped: val };
  return val;
});
[JSON.stringify(v), JSON.stringify(root), log.join(' ')].join(' | ')
// ---
// B6 extra: repeated keys whose earlier values are deep (their source subtrees are dropped
// during the parse), at several depths, with and without a reviver.
var r = [];
[10, 500, 1500, 1900].forEach(function (d) {
  var deep = '['.repeat(d) + '{"x":1}' + ']'.repeat(d);
  var text = '{"a":' + deep + ',"b":2,"a":{"y":"' + d + '"},"c":' + deep + ',"c":[0]}';
  var calls = 0;
  var v = JSON.parse(text, function (k, val, ctx) { calls++; return val; });
  r.push(d + ':' + calls + ':' + JSON.stringify(v));
  r.push(JSON.stringify(JSON.parse(text)));
});
r.join(' ')
// ---
// B6 extra: a deep source tree retained through a revive that throws at its deepest leaf; the
// tree is dropped on the error path, then a revive at the same depth completes.
var r = [];
var d = 1900;
var text = '{"k":'.repeat(d) + '"leaf"' + '}'.repeat(d);
try { JSON.parse(text, function (k, v) { if (v === 'leaf') throw new Error('deep'); return v; }); } catch (e) { r.push(e.message); }
var calls = 0;
JSON.parse(text, function (k, v) { calls++; return v; });
r.push(calls);
r.join()
// ---
// B6 extra: errors from every phase of the walk at depth, each caught: the Get (a getter the
// reviver installed), IsArray of a revoked Proxy, length, ownKeys, the descriptor read, the
// write-back (define and delete traps), the key slot and the reviver itself.
var r = [];
var rv = Proxy.revocable([], {}); rv.revoke();
var installs = [
  function (h) { Object.defineProperty(h, 'z', { get: function () { throw new Error('get'); }, enumerable: true, configurable: true }); },
  function (h) { h.z = rv.proxy; },
  function (h) { h.z = new Proxy([], { get: function (t, k) { if (k === 'length') throw new Error('length'); return t[k]; } }); },
  function (h) { h.z = new Proxy({}, { ownKeys: function () { throw new Error('ownKeys'); } }); },
  function (h) { h.z = new Proxy({ q: 1 }, { getOwnPropertyDescriptor: function () { throw new Error('gopd'); } }); },
  function (h) { h.z = new Proxy({ q: 1 }, { defineProperty: function () { throw new Error('define'); } }); },
  function (h) { h.z = new Proxy({ q: 1 }, { deleteProperty: function () { throw new Error('delete'); } }); },
];
for (var d = 1; d < 1000; d += 300) {
  installs.forEach(function (install, j) {
    var text = '[{"a":'.repeat(d) + '{"y":0,"z":0}' + '}]'.repeat(d);
    try {
      JSON.parse(text, function (k, val) { if (k === 'y') install(this); if (k === 'q') return j === 6 ? undefined : 'Q'; return val; });
      r.push('ok');
    } catch (e) { r.push(e.message); }
  });
  try { JSON.parse('[' + d + ']', function () { throw new RangeError('rev' + d); }); } catch (e) { r.push(e.message); }
}
var calls = 0;
JSON.parse('['.repeat(1900) + ']'.repeat(1900), function (k, v) { calls++; return v; });
r.push(calls);
r.join()
// ---
// B6 extra: the reviver re-enters JSON.parse with its own reviver and JSON.stringify at depth,
// and the inner revive throws, is caught, and is retried.
var log = [];
var outer = '[' + '{"s":"[[1,{\\"t\\":2}]]"}' + ',' + '{"s":"{\\"bad\\":1}"}' + ']';
var v = JSON.parse(outer, function (k, val, ctx) {
  if (k === 's') {
    try { return JSON.parse(val, function (k2, v2, c2) { log.push('in:' + k2 + ':' + ('source' in c2 ? c2.source : '-')); if (k2 === 'bad') throw new Error('bad'); return v2; }); }
    catch (e) { log.push('caught:' + e.message); return JSON.parse(val, function (k2, v2) { return k2 === 'bad' ? JSON.stringify([v2, this]) : v2; }); }
  }
  log.push('out:' + k + ':' + ('source' in ctx ? ctx.source : '-'));
  return val;
});
[JSON.stringify(v), log.join(' ')].join(' | ')
// ---
// B6 extra: a wide object of index keys (stored by index), half of them named by the reviver as
// the walk runs, every fifth deleted, and source contexts checked throughout.
var parts = [];
for (var i = 0; i < 20000; i++) parts.push('"' + i + '":' + (i % 3 ? i : '[' + i + ']'));
var withSource = 0, without = 0, calls = 0;
var v = JSON.parse('{' + parts.join(',') + ',"tail":{"0":0}}', function (k, val, ctx) {
  calls++;
  if ('source' in ctx) withSource++; else without++;
  if (k === '100') { for (var j = 101; j < 20000; j += 2) Object.defineProperty(this, j, { value: j, writable: true, enumerable: true, configurable: true }); }
  if (k !== '' && +k % 5 === 0) return undefined;
  return val;
});
[calls, withSource, without, Object.keys(v).length, JSON.stringify(v).length].join()
// ---
// B6 extra: own "__proto__" keys, accessor-valued revivals, and revivals onto a frozen and a
// non-extensible holder (CreateDataProperty fails silently; delete fails silently).
var log = [];
var v = JSON.parse('{"__proto__":{"p":1},"a":{"b":1,"c":2},"d":[1,2,3],"e":{"f":1}}', function (k, val) {
  log.push(k);
  if (k === 'b') { Object.preventExtensions(this); return 'B'; }
  if (k === 'c') { this.zz = 1; return undefined; }
  if (k === '0') { Object.freeze(this); return undefined; }
  if (k === 'f') { Object.defineProperty(this, 'f', { get: function () { return 'getter'; }, configurable: false }); return 'F'; }
  return val;
});
[JSON.stringify(v), Object.getPrototypeOf(v) === Object.prototype, Object.keys(v).join('+'), log.join()].join(' | ')
// ---
// B6 extra: non-function and exotic revivers: a bound function, a Proxy of a function, a
// native (String), and a non-callable object (ignored).
var r = [];
function rev(k, v) { return typeof v === 'number' ? v + this.add : v; }
r.push(JSON.stringify(JSON.parse('{"a":[1,{"b":2}]}', rev.bind({ add: 10 }))));
var log = [];
r.push(JSON.stringify(JSON.parse('[1,[2]]', new Proxy(function (k, v) { return v; }, { apply: function (t, th, args) { log.push(args[0] + ':' + args.length); return Reflect.apply(t, th, args); } }))));
r.push(JSON.stringify(JSON.parse('{"x":[1,true]}', String)));
r.push(JSON.stringify(JSON.parse('{"x":[1,true]}', { call: 1 })));
[r.join(' '), log.join()].join(' | ')
// ---
// B6 extra: the reviver installs a deep nest at a later sibling; the walk descends into it
// (no retained sources there) and revives every level.
var calls = 0;
var deep = 0; for (var i = 0; i < 1500; i++) deep = i % 2 ? [deep] : { d: deep };
var v = JSON.parse('{"a":1,"b":2}', function (k, val, ctx) { calls++; if (k === 'a') this.b = deep; return val; });
calls
// ---
// B6 extra: a huge array length on a Proxy installed at a later sibling: the walk reads its
// length and visits indices until the meter's heap admission stops it.
var v = JSON.parse('{"a":1,"b":2}', function (k, val) {
  if (k === 'a') this.b = new Proxy([], { get: function (t, k) { return k === 'length' ? 2e9 : undefined; } });
  return val;
});
'unreached'
// ---
// B6 extra: an array nest revived with a counting reviver, at the ceiling (1997).
var calls = 0; JSON.parse('['.repeat(1997) + '1' + ']'.repeat(1997), function (k, v, c) { calls++; return v; }); calls
// ---
// B6 extra: an array nest revived with a counting reviver, one past the ceiling (1998).
var calls = 0; JSON.parse('['.repeat(1998) + '1' + ']'.repeat(1998), function (k, v, c) { calls++; return v; }); calls
// ---
// B6 extra: an object nest revived with a counting reviver, at the ceiling (1997).
var calls = 0; JSON.parse('{"a":'.repeat(1997) + '{}' + '}'.repeat(1997), function (k, v) { calls++; return k === 'a' ? v : v; }); calls
// ---
// B6 extra: an object nest revived with a counting reviver, one past the ceiling (1998).
var calls = 0; JSON.parse('{"a":'.repeat(1998) + '{}' + '}'.repeat(1998), function (k, v) { calls++; return k === 'a' ? v : v; }); calls
// ---
// B6 extra: a revive inside toJSON at depth 40 of an outer stringify, at the ceiling (1926).
var text = '[{"k":'.repeat(1926 >> 1) + (1926 & 1 ? '[0]' : '0') + '}]'.repeat(1926 >> 1);
var t = { toJSON: function () { var n = 0; JSON.parse(text, function (k, v) { n++; return v; }); return n; } };
var o = t; for (var i = 0; i < 40; i++) o = i % 2 ? [o] : { k: o };
JSON.stringify(o)
// ---
// B6 extra: a revive inside toJSON at depth 40 of an outer stringify, one past the ceiling (1927).
var text = '[{"k":'.repeat(1927 >> 1) + (1927 & 1 ? '[0]' : '0') + '}]'.repeat(1927 >> 1);
var t = { toJSON: function () { var n = 0; JSON.parse(text, function (k, v) { n++; return v; }); return n; } };
var o = t; for (var i = 0; i < 40; i++) o = i % 2 ? [o] : { k: o };
JSON.stringify(o)
// ---
// B6 extra: an array nest revived after 80 errors caught mid-walk (no unit leaks), at the ceiling (1997).
var r = 0;
for (var n = 0; n < 40; n++) {
  var text = '[{"a":'.repeat(900 - n) + '"x"' + '}]'.repeat(900 - n);
  try { JSON.parse(text, function (k, v) { if (v === 'x') throw new Error('x'); return v; }); } catch (e) { r++; }
  try { JSON.parse('{"a":1,"b":2}', function (k, v) { if (k === 'a') this.b = new Proxy({}, { ownKeys: function () { throw new Error('k'); } }); return v; }); } catch (e) { r++; }
}
var calls = 0; JSON.parse('['.repeat(1997) + '1' + ']'.repeat(1997), function (k, v) { calls++; return v; });
r + ':' + calls
// ---
// B6 extra: an array nest revived after 80 errors caught mid-walk (no unit leaks), one past the ceiling (1998).
var r = 0;
for (var n = 0; n < 40; n++) {
  var text = '[{"a":'.repeat(900 - n) + '"x"' + '}]'.repeat(900 - n);
  try { JSON.parse(text, function (k, v) { if (v === 'x') throw new Error('x'); return v; }); } catch (e) { r++; }
  try { JSON.parse('{"a":1,"b":2}', function (k, v) { if (k === 'a') this.b = new Proxy({}, { ownKeys: function () { throw new Error('k'); } }); return v; }); } catch (e) { r++; }
}
var calls = 0; JSON.parse('['.repeat(1998) + '1' + ']'.repeat(1998), function (k, v) { calls++; return v; });
r + ':' + calls
// ---
// B6 extra: a nest the reviver installs at a later sibling (no retained sources), at the ceiling (1996).
var calls = 0;
var deep = 0; for (var i = 0; i < 1996; i++) deep = i % 2 ? [deep] : { d: deep };
JSON.parse('{"a":1,"b":2}', function (k, val) { calls++; if (k === 'a') this.b = deep; return val; });
calls
// ---
// B6 extra: a nest the reviver installs at a later sibling (no retained sources), one past the ceiling (1997).
var calls = 0;
var deep = 0; for (var i = 0; i < 1997; i++) deep = i % 2 ? [deep] : { d: deep };
JSON.parse('{"a":1,"b":2}', function (k, val) { calls++; if (k === 'a') this.b = deep; return val; });
calls
// ---
// B6 extra: a revive nested in a reviver at depth 11, at the ceiling (1954).
var inner = '['.repeat(1954) + ']'.repeat(1954);
var n = 0;
JSON.parse('[[[[[[[[[[{"s":0}]]]]]]]]]]', function (k, v) { if (k === 's') JSON.parse(inner, function (k2, v2) { n++; return v2; }); return v; });
n
// ---
// B6 extra: a revive nested in a reviver at depth 11, one past the ceiling (1955).
var inner = '['.repeat(1955) + ']'.repeat(1955);
var n = 0;
JSON.parse('[[[[[[[[[[{"s":0}]]]]]]]]]]', function (k, v) { if (k === 's') JSON.parse(inner, function (k2, v2) { n++; return v2; }); return v; });
n
// ---
// B6 extra: a Proxy nest the reviver installs at a later sibling, at the ceiling (1980).
var log = 0;
var h = { get: function (t, k, r) { log++; return Reflect.get(t, k, r); } };
var deep = 0; for (var i = 0; i < 1980; i++) deep = new Proxy(i % 2 ? [deep] : { d: deep }, h);
JSON.parse('{"a":1,"b":2}', function (k, val) { if (k === 'a') this.b = deep; return val; });
log
// ---
// B6 extra: a Proxy nest the reviver installs at a later sibling, one past the ceiling (1981).
var log = 0;
var h = { get: function (t, k, r) { log++; return Reflect.get(t, k, r); } };
var deep = 0; for (var i = 0; i < 1981; i++) deep = new Proxy(i % 2 ? [deep] : { d: deep }, h);
JSON.parse('{"a":1,"b":2}', function (k, val) { if (k === 'a') this.b = deep; return val; });
log
// ---
// B6 extra: a revive inside an Array.prototype.map callback, at the ceiling (1967).
var text = '{"a":['.repeat(1967 >> 1) + (1967 & 1 ? '{}' : '1') + ']}'.repeat(1967 >> 1);
[0].map(function () { var n = 0; JSON.parse(text, function (k, v) { n++; return v; }); return n; })[0]
// ---
// B6 extra: a revive inside an Array.prototype.map callback, one past the ceiling (1968).
var text = '{"a":['.repeat(1968 >> 1) + (1968 & 1 ? '{}' : '1') + ']}'.repeat(1968 >> 1);
[0].map(function () { var n = 0; JSON.parse(text, function (k, v) { n++; return v; }); return n; })[0]
// ---
// B6 extra: an array nest whose leaf reviver calls nested array callbacks, at the ceiling (1901).
var calls = 0;
JSON.parse('['.repeat(1901) + '1' + ']'.repeat(1901), function (k, v, c) { calls++; if (v === 1) [0].map(function () { [0].forEach(function () { [0].some(function () { return calls++; }); }); }); return v; });
calls
// ---
// B6 extra: an array nest whose leaf reviver calls nested array callbacks, one past the ceiling (1902).
var calls = 0;
JSON.parse('['.repeat(1902) + '1' + ']'.repeat(1902), function (k, v, c) { calls++; if (v === 1) [0].map(function () { [0].forEach(function () { [0].some(function () { return calls++; }); }); }); return v; });
calls
// ---
// B6 extra: an object nest whose leaf reviver stringifies its context at depth 10, at the ceiling (1970).
var calls = 0;
JSON.parse('{"a":'.repeat(1970) + '[1]' + '}'.repeat(1970), function (k, v, c) { calls++; if (v === 1) { var x = JSON.stringify([[[[[[[[[[c]]]]]]]]]]); calls += x.length; } return v; });
calls
// ---
// B6 extra: an object nest whose leaf reviver stringifies its context at depth 10, one past the ceiling (1971).
var calls = 0;
JSON.parse('{"a":'.repeat(1971) + '[1]' + '}'.repeat(1971), function (k, v, c) { calls++; if (v === 1) { var x = JSON.stringify([[[[[[[[[[c]]]]]]]]]]); calls += x.length; } return v; });
calls
