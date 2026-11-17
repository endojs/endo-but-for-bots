// D1: every binary operator in a left-nested run, mixed with right-nested and parenthesized
// operands, unary, logical and conditional operators; run so the values are compared too.
var a = 7, b = 3, o = { k: 1 }, F = function () {};
var r = [
  a + b - a * b / a % b ** 2,
  a & b | a ^ b << 1 >> 1 >>> 0,
  a == b != a === b !== (a < b) <= (a > b) >= a,
  'k' in o instanceof Object,
  a + (b + (a + b)) + -a + +b - ~a + !b,
  a + b * a - b / a + (a || b) - (a && b) + (a ?? b) + (a ? b : a) + (a, b),
  1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20,
  'a' + 1 + 2 + 'b' + 3 * 4 + 5,
];
r.join()
// ---
// flags: --eval-compiler
// A long left-nested chain of each operator through eval, at the depth the parser allows.
var ops = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '==', '!=', '===', '!==', '<', '<=', '>', '>='];
var out = [];
for (var i = 0; i < ops.length; i++) {
  var src = '1' + (' ' + ops[i] + ' 1').repeat(1500);
  try { out.push(String(eval(src))); } catch (e) { out.push(e.name); }
}
out.join()
// ---
// flags: --compile-only
// A 70-term `+` chain with a call, a member and a conditional inside some operands.
var x = 1 + f(1) + o.p + (c ? 1 : 2) + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1;
// ---
// flags: --eval-compiler
// Annex B duplicate `__proto__` setters, at depth and beside shorthand and computed keys:
// the first duplicate found is the one reported, in pre-order.
var r = [];
var srcs = [
  '({ __proto__: 1, __proto__: 2 })',
  '({ a: { b: { __proto__: 1, x: 0, __proto__: 2 } } })',
  '[{ __proto__: 1 }, { __proto__: 1, "__proto__": 2 }]',
  '({ __proto__, __proto__: 1 })',
  '({ ["__proto__"]: 1, __proto__: 2 })',
  '({ __proto__: 1, a: { __proto__: 1, __proto__: 2 }, __proto__: 3 })',
  '({ __proto__: 1 } = {})',
  '(function () { return { __proto__: 1,\n __proto__: 2 }; })',
];
for (var i = 0; i < srcs.length; i++) {
  try { eval(srcs[i]); r.push('ok'); } catch (e) { r.push(e.name + ':' + e.message); }
}
r.join(' | ')
// ---
// flags: --eval-compiler
// Deep default-arm nests for the scoper's hoist and bind work stacks: blocks, statements,
// expressions and declarations interleaved, hoisted functions and vars at depth.
var src = '';
for (var i = 0; i < 300; i++) src += i % 3 === 0 ? '{ ' : i % 3 === 1 ? 'if (x) { ' : 'label' + i + ': { var v' + i + ' = ' + i + '; ';
src += 'function deep() { return typeof v2 + typeof deep; } r = deep(); ';
src += '}'.repeat(300);
var x = 1, y = 1, r;
eval(src);
[r, typeof v2, typeof v299].join()
// ---
// flags: --eval-compiler
// Bindings inside the default bind arm: assignments, updates, deletes and templates nested
// in operators, with closures capturing names declared at depth.
var log = [];
var s = 'var a = 0; var t = function () { return a; };';
for (var i = 0; i < 100; i++) s += '(a += ' + i + ', a++, delete o.k, `${a}`) + ';
s += '0; log.push(t(), a);';
var o = { k: 1 };
eval(s);
log.join()
// ---
// flags: --eval-compiler
// Refusals at the depth limits: deep parens, deep binary nests and deep blocks are refused
// with the same error; then a compile at the edge still works.
var r = [];
['('.repeat(5000) + '1' + ')'.repeat(5000), '1' + '+1'.repeat(5000), '{'.repeat(1000) + '}'.repeat(1000),
 'a' + '.b'.repeat(3000), 'f' + '()'.repeat(3000), '-'.repeat(3000) + '1'].forEach(function (s) {
  try { eval(s); r.push('ok'); } catch (e) { r.push(e.name + ':' + e.message); }
});
r.push(eval('1' + '+1'.repeat(1990)));
r.join(' | ')
// ---
// flags: --compile-only
// A tree the parser refuses after building most of it (an 83-deep nest): the partial tree
// is freed.
var x = (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((1)))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))) + ;
// ---
// flags: --eval-compiler
// The same chains compiled through eval's compiler path.
var r = [];
r.push(eval('1' + ' + 2'.repeat(1000)));
r.push(eval('var q = 0; ' + '{ q++; '.repeat(200) + '}'.repeat(200) + ' q'));
try { eval('1' + ' * 2'.repeat(4000)); } catch (e) { r.push(e.name); }
r.join()
