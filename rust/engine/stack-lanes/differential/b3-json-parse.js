// B3: JSON.parse nesting with an explicit container stack. Malformed input at every nesting
// position, each one caught, then a parse at the ceiling: a unit the error path left charged
// would halt the last parse early.
var bad = [
  '', ' ', '[', '{', '[1', '[1,', '[1,]', '[,1]', '[1 2]', '{"a"', '{"a":', '{"a":}', '{"a" 1}',
  '{"a":1', '{"a":1,', '{"a":1,}', '{,}', '{a:1}', "{'a':1}", '{"a":1 "b":2}', '[1]]', '[1]x',
  '{"a":1}}', 'nul', 'tru', 'fals', '01', '-', '1.', '.5', '1e', '"\\x"', '"abc', '[-]', '[+1]',
  '{"a":[1,{"b":[2,{"c":}]}]}', '[[[[[[[[[[1]]]]]]]]]', '{"a":{"b":{"c":{"d":1}}}',
];
var r = [];
for (var i = 0; i < bad.length; i++) {
  try { JSON.parse(bad[i]); r.push('ok:' + i); } catch (e) { r.push(e.name); }
}
for (var d = 1; d < 2000; d += 97) {
  try { JSON.parse('['.repeat(d) + '1,'); } catch (e) { r.push(d); }
  try { JSON.parse('{"k":'.repeat(d) + '"open'); } catch (e) { r.push(-d); }
}
r.push(JSON.parse('['.repeat(2000) + ']'.repeat(2000)).length);
r.join()
// ---
// Alternating containers, deep, with scalars, empty containers and whitespace of every kind at
// every position; then the structure read back.
var ws = [' ', '\t', '\n', '\r', '  \n\t'];
var s = '', close = '';
for (var i = 0; i < 900; i++) {
  var w = ws[i % ws.length];
  if (i % 2) { s += w + '{' + w + '"k' + i + '"' + w + ':' + w; close = w + '}' + close; }
  else { s += w + '[' + w + i + w + ',' + w + '[]' + w + ',' + w + '{}' + w + ',' + w; close = w + ']' + close; }
}
var v = JSON.parse(s + 'null' + close);
var depth = 0, sum = 0, cur = v;
while (cur !== null) {
  depth++;
  if (Array.isArray(cur)) { sum += cur[0] + cur.length; cur = cur[3]; }
  else { var k = Object.keys(cur)[0]; sum += k.length; cur = cur[k]; }
}
[depth, sum].join()
// ---
// Objects: repeated keys (the last wins), index keys (array-like and past the index range),
// "__proto__" as a plain key, keys needing escapes, and nesting under each.
var t = '{"a":1,"a":{"x":[1,2,{"a":3,"a":4}]},"0":"zero","1":{"0":[],"0":[9]},' +
  '"4294967294":"max","4294967295":"past","-0":"neg","00":"lead","__proto__":{"p":1},' +
  '"\\u0061b":"ab","\\ud83d\\ude00":"smile","":{"":{"":[]}}}';
var o = JSON.parse(t);
[JSON.stringify(o), Object.keys(o).join('|'), Object.getPrototypeOf(o) === Object.prototype,
  o.__proto__.p, Object.keys(o[1]).join()].join(' ')
// ---
// Scalars at depth: numbers at the edges of their classification, strings with escapes, and
// the keywords, each inside a different container.
var items = ['0', '-0', '1', '-1', '2147483647', '2147483648', '-2147483648', '-2147483649',
  '1e400', '-1e400', '1e-400', '0.1', '1.5e3', '123456789012345678901234567890', '"\\u0000"',
  '"\\"\\\\\\/\\b\\f\\n\\r\\t"', '"\\ud800"', '"é€😀"', 'true', 'false', 'null'];
var s = '[';
for (var i = 0; i < items.length; i++) s += (i ? ',' : '') + '[{"v":' + items[i] + '}]';
var v = JSON.parse(s + ']');
var out = [];
for (var i = 0; i < v.length; i++) {
  var x = v[i][0].v;
  out.push(typeof x + ':' + (typeof x === 'string' ? x.length + '/' + x.charCodeAt(0) : Object.is(x, -0) ? '-0' : String(x)));
}
out.join()
// ---
// Wide containers under nesting: 3 levels of 3,000-element arrays and objects.
var row = '[' + Array.from({ length: 3000 }, function (_, i) { return i; }).join(',') + ']';
var obj = '{' + Array.from({ length: 3000 }, function (_, i) { return '"k' + i + '":' + i; }).join(',') + '}';
var v = JSON.parse('[' + row + ',{"o":' + obj + ',"a":[' + row + ',' + obj + ']}]');
[v[0].length, v[0][2999], Object.keys(v[1].o).length, v[1].o.k2999, v[1].a[0][1500],
  v[1].a[1].k7].join()
// ---
// A reviver over deep input: source text for every primitive at depth, a holder rewritten
// before its children are visited, and the call order.
var log = [];
var text = '{"a":[1,{"b":[2,"x",{"c":true}]},null],"d":{"e":{"f":-0.5}}}';
var v = JSON.parse(text, function (k, val, ctx) {
  log.push(k + '=' + (ctx && 'source' in ctx ? ctx.source : '-'));
  if (k === 'b') this.extra = 1;
  return val;
});
[log.join('|'), JSON.stringify(v)].join(' ')
// ---
// A reviver over a deep chain, near its ceiling; and repeated keys whose earlier values the
// reviver never sees.
var n = 600;
var calls = 0;
var v = JSON.parse('{"a":'.repeat(n) + '{"x":1,"x":2,"x":[3]}' + '}'.repeat(n), function (k, val) {
  calls++;
  return k === 'x' ? 'last:' + JSON.stringify(val) : val;
});
var cur = v;
for (var i = 0; i < n; i++) cur = cur.a;
[calls, cur.x].join()
// ---
// JSON.parse re-entered from a reviver at several depths of an outer parse, each inner parse
// at its own deep nesting, so the inner ceilings sit on top of the outer walk's units.
var r = [];
var outer = '['.repeat(40) + '"go"' + ']'.repeat(40);
JSON.parse(outer, function (k, v) {
  if (v === 'go') {
    for (var d = 1900; d <= 2010; d += 10) {
      try { JSON.parse('['.repeat(d) + ']'.repeat(d)); r.push(d); } catch (e) { r.push('e' + d); }
    }
  }
  return v;
});
r.join()
// ---
// The ceiling inside a callback: Array.prototype.map's heavy frame below the parse.
var r = [];
[0, 1].map(function () {
  for (var d = 1980; d <= 2020; d += 4) {
    try { JSON.parse('{"a":'.repeat(d) + '0' + '}'.repeat(d)); r.push(d); } catch (e) { r.push('x'); }
  }
});
r.join()
// ---
// One past the ceiling halts; the halt is reported with the depth the recursion reported.
JSON.parse('[{"a":'.repeat(1008) + '1' + '}]'.repeat(1008));
// ---
// Halt on an object member value at the ceiling.
JSON.parse('{"a":'.repeat(2100) + '1' + '}'.repeat(2100));
// ---
// Halt on an empty container just past the ceiling, and on a scalar just past it.
var r = [];
try { JSON.parse('['.repeat(2015) + '[]' + ']'.repeat(2015)); r.push('a'); } catch (e) { r.push(e.name); }
try { JSON.parse('['.repeat(2015) + '{}' + ']'.repeat(2015)); r.push('b'); } catch (e) { r.push(e.name); }
try { JSON.parse('['.repeat(2015) + '7' + ']'.repeat(2015)); r.push('c'); } catch (e) { r.push(e.name); }
JSON.parse('['.repeat(2016) + '"s"' + ']'.repeat(2016));
r.join()
// ---
// The re-entered parse below its ceiling, so the run returns its results.
var r = [];
JSON.parse('['.repeat(40) + '"go"' + ']'.repeat(40), function (k, v) {
  if (v === 'go') {
    for (var d = 1800; d <= 1940; d += 20) {
      JSON.parse('['.repeat(d) + ']'.repeat(d)); r.push(d);
    }
  }
  return v;
});
r.join()
// ---
// The callback parse below its ceiling.
var r = [];
[0, 1].map(function (x) {
  for (var d = 1900; d <= 1980; d += 10) {
    JSON.parse('{"a":'.repeat(d) + x + '}'.repeat(d)); r.push(d);
  }
});
r.join()
// ---
// Empty containers and a scalar at the ceiling complete.
var r = [];
r.push(JSON.parse('['.repeat(2015) + '[]' + ']'.repeat(2015)).length);
r.push(JSON.parse('['.repeat(2015) + '{}' + ']'.repeat(2015)).length);
r.push(JSON.parse('['.repeat(2015) + '7' + ']'.repeat(2015)).length);
r.join()

// ---
// From the pre-commit review: B3 review: a truncated nest exactly at the ceiling: the enter for the missing value refuses
// before the end-of-input SyntaxError would be raised.
JSON.parse('['.repeat(2016));
// ---
// One level shallower the missing value is a catchable SyntaxError; then the ceiling parses.
var r = [];
try { JSON.parse('['.repeat(2015)); } catch (e) { r.push(e.name); }
try { JSON.parse('['.repeat(2015) + 'x'); } catch (e) { r.push(e.name); }
try { JSON.parse('{"a":'.repeat(2015)); } catch (e) { r.push(e.name); }
try { JSON.parse('{"a":'.repeat(2015) + '}'); } catch (e) { r.push(e.name); }
r.push(JSON.parse('['.repeat(2015) + '[]' + ']'.repeat(2015)).length);
r.join()
// ---
// An invalid token at the ceiling+1 position: the refusal wins over the SyntaxError.
JSON.parse('['.repeat(2016) + 'x');
// ---
// An object member key error at every depth up to the ceiling (missing colon, bad key, bad
// escape in a key, unterminated key, a comma before a missing key), each caught, then the
// ceiling parses: a unit left charged by any error path would halt the last parse.
var r = 0;
var tails = ['"k" 1}', 'k:1}', '"\\q":1}', '"abc', '"a":1,}', '"a":1 "b":2}', '"a":1,"b"', '"a":[1,]}'];
for (var d = 1; d <= 2014; d += 53) {
  for (var t = 0; t < tails.length; t++) {
    try { JSON.parse('{"a":'.repeat(d) + '{' + tails[t]); } catch (e) { if (e instanceof SyntaxError) r++; }
  }
}
[r, JSON.parse('{"a":'.repeat(2015) + '1' + '}'.repeat(2015)) !== null].join()
// ---
// The same at exactly the ceiling: the innermost container's value takes the last unit, so the
// error is raised with the whole budget held.
var r = [];
var tails = ['"k" 1}', 'k:1}', '"\\q":1}', '"abc', '"a":1,}', '"a":1 "b":2}', '1]', '1,]', '1 2]', '[]x', '{}}', '1'];
for (var t = 0; t < tails.length; t++) {
  var open = t < 6 ? '{' : '[';
  try { JSON.parse('['.repeat(2014) + open + tails[t]); r.push('ok' + t); } catch (e) { r.push(e.name + t); }
}
r.push(JSON.parse('['.repeat(2014) + '{"a":[]}' + ']'.repeat(2014)).length);
r.join()
// ---
// Errors raised while closing: a container closed by the wrong bracket at every depth.
var r = [];
for (var d = 2; d <= 2015; d += 101) {
  try { JSON.parse('['.repeat(d) + '}'.repeat(d)); } catch (e) { r.push(d); }
  try { JSON.parse('{"x":'.repeat(d - 1) + '[' + ']'.repeat(d)); } catch (e) { r.push(-d); }
  try { JSON.parse('['.repeat(d) + ']'.repeat(d) + ']'); } catch (e) { r.push('t' + d); }
}
r.push(JSON.parse('['.repeat(2016) + ']'.repeat(2016)).length);
r.join()
// ---
// Whitespace between every token at the ceiling, of every kind, including before the first
// value and after the last bracket.
var ws = [' ', '\t', '\n', '\r', '\r\n\t '];
var s = ' \n';
for (var i = 0; i < 2015; i++) s += ws[i % 5] + (i % 3 ? '[' : '{' + ws[(i + 1) % 5] + '"k"' + ws[(i + 2) % 5] + ':');
s += ws[0] + '-0.5e-3' + ws[1];
for (var i = 2014; i >= 0; i--) s += ws[(i + 3) % 5] + (i % 3 ? ']' : '}');
s += '\t\n';
var v = JSON.parse(s);
var depth = 0;
while (typeof v === 'object') { v = Array.isArray(v) ? v[0] : v.k; depth++; }
[depth, v].join()
// ---
// The ceiling from inside a reviver call at several depths of an outer reviver walk, each
// attempt preceded by syntax errors at depth: the inner ceilings sit on the outer units.
var r = [];
var outer = '{"a":'.repeat(30) + '[1,"go",3]' + '}'.repeat(30);
JSON.parse(outer, function (k, v) {
  if (v === 'go') {
    for (var d = 1940; d <= 1952; d += 3) {
      try { JSON.parse('['.repeat(d - 1) + '1,'); } catch (e) { r.push('s'); }
      try { JSON.parse('['.repeat(d) + ']'.repeat(d)); r.push(d); } catch (e) { r.push('e' + d); }
    }
  }
  return v;
});
r.join()
// ---
// The inner parse one past its ceiling inside a reviver halts with the same depth.
var outer = '{"a":'.repeat(30) + '[1,"go",3]' + '}'.repeat(30);
JSON.parse(outer, function (k, v) {
  if (v === 'go') { JSON.parse('['.repeat(1952) + ']'.repeat(1952)); try { JSON.parse('['.repeat(1952) + '1,'); } catch (e) {} JSON.parse('['.repeat(1953) + ']'.repeat(1953)); }
  return v;
});
// ---
// JSON.parse re-entered from the ToString of its own text argument, which itself parses
// deep text with errors first.
var r = [];
var text = { toString: function () {
  try { JSON.parse('['.repeat(1500) + '{"a" 1}'); } catch (e) { r.push(e.name); }
  r.push(JSON.parse('['.repeat(1984) + ']'.repeat(1984)).length);
  return '['.repeat(1000) + '7' + ']'.repeat(1000);
} };
var v = JSON.parse(text);
for (var i = 0; i < 1000; i++) v = v[0];
r.push(v);
r.join()
// ---
// Source tracking (a reviver) over deep repeated keys, index keys and nested empties, the
// reviver reading context.source of each primitive and rewriting holders.
var log = [];
var t = '{"0":' + '{"1":[{"x":1,"x":"two","0":[]},{"0":{},"0":[3]}],"y":'.repeat(200) + '"s"' + '}'.repeat(200) + ',"0":false}';
var v = JSON.parse(t, function (k, val, ctx) {
  if (ctx && 'source' in ctx) log.push(k + '=' + ctx.source);
  if (k === 'x') { this['0'] = 'replaced'; }
  return val;
});
[log.length, log.slice(0, 8).join('|'), log.slice(-4).join('|'), JSON.stringify(v).length].join(' ')
// ---
// Wide containers at depth near the ceiling: each level a 50-element array whose last element
// opens the next level, so every element charge and close happens at depth.
var parts = [];
for (var i = 0; i < 1900; i++) parts.push('[' + '0,'.repeat(49));
var v = JSON.parse(parts.join('') + '1' + ']'.repeat(1900));
var n = 0;
while (Array.isArray(v)) { n += v.length; v = v[v.length - 1]; }
[n, v].join()
// ---
// Numbers malformed at the deepest level, each caught, then the ceiling.
var r = [];
var bad = ['-', '1.', '.5', '1e', '1e+', '01', '-01', '0x1', 'Infinity', 'NaN', '+1', '1.e3', '- 1', 'tru', 'nul', 'falsey', '"\\u12"', '"\\ud800\\u"', '"\u0001"'];
for (var i = 0; i < bad.length; i++) {
  try { JSON.parse('['.repeat(2015) + bad[i] + ']'.repeat(2015)); r.push('ok' + i); } catch (e) { r.push(e.name.length); }
}
r.push(JSON.parse('['.repeat(2015) + '1e400' + ']'.repeat(2015)).length);
r.join()
// ---
// The ceiling inside a getter run by Array.prototype.join at depth, after errors.
var r = [];
var o = {};
Object.defineProperty(o, 'toString', { value: function () {
  for (var d = 1901; d <= 1919; d += 2) {
    try { JSON.parse('{"a":'.repeat(d - 1) + '[1}'); } catch (e) { r.push(e.name[0]); }
    try { JSON.parse('{"a":'.repeat(d) + '1' + '}'.repeat(d)); r.push(d); } catch (e) { r.push('x' + d); }
  }
  return 'o';
} });
[[[o]]].join();
r.join()
// ---
// The callback form one past the ceiling: the halt depth inside forEach.
[0].forEach(function () { JSON.parse('{"a":'.repeat(2000) + '1' + '}'.repeat(2000)); });
// ---
// An array whose closing bracket arrives after a long run of members, with a syntax error at
// the very last position at the ceiling.
var r = [];
try { JSON.parse('['.repeat(2014) + '[' + '1,'.repeat(5000) + '2' + ']'.repeat(2014)); } catch (e) { r.push(e.name); }
try { JSON.parse('['.repeat(2014) + '{' + '"k":1,'.repeat(5000) + '"z":[]' + ']'.repeat(2014)); } catch (e) { r.push(e.name); }
r.push(JSON.parse('['.repeat(2015) + '[]' + ']'.repeat(2015)).length);
r.join()
// ---
// HeapExhausted decided inside the parse at depth: the element admission of a wide array under
// 1,500 open containers crosses the chunk budget.
var filler = 'a'.repeat(2 ** 25);
var t = '['.repeat(1500) + '[' + '1,'.repeat(6000000) + '1]' + ']'.repeat(1500);
var r;
try { r = JSON.parse(t); } catch (e) { r = e.name; }
typeof r
// ---
// The same with source tracking (a reviver), so the source-list admission is also in play.
var filler = 'a'.repeat(2 ** 25);
var t = '{"k":'.repeat(1500) + '[' + '1,'.repeat(4000000) + '1]' + '}'.repeat(1500);
var r;
try { r = JSON.parse(t, function (k, v) { return v; }); } catch (e) { r = e.name; }
typeof r
