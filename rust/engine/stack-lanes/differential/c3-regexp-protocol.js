// C3: a String method calls the intrinsic RegExp protocol method (`@@replace`, `@@split`,
// `@@match`, `@@search`, `@@matchAll`) in its own activation instead of through
// `invoke_value`. Every protocol through the intrinsic, with string and function
// replacements, limits, flags and lastIndex, so results and meters compare.
var r = [];
r.push('aXbXc'.replace(/X/, '-'), 'aXbXc'.replace(/X/g, '[$&]'), 'abc'.replace(/(b)/, '$1$1$`'));
r.push('a1b2'.replace(/[0-9]/g, function (m, i) { return '<' + m + i + '>'; }));
r.push('aXbXc'.replaceAll(/X/g, '+'), 'a,b,,c'.split(/,/), 'a,b,,c'.split(/,/, 2).join('|'));
r.push('xAyAz'.match(/A/).index, 'xAyAz'.match(/A/g).length, 'xAyAz'.search(/y/), 'q'.match(/z/));
r.push([...'a1b2c3'.matchAll(/[a-z]/g)].map(function (m) { return m[0] + m.index; }).join());
var re = /b/g; re.lastIndex = 2;
r.push('abcb'.replace(re, 'B'), re.lastIndex, 'abcb'.split(re).join('/'), re.lastIndex);
var sticky = /a/y; r.push('aab'.replace(sticky, '-'), sticky.lastIndex, 'baa'.search(sticky));
r.join(' ')
// ---
// Non-string receivers and arguments are coerced as before, in the same order.
var log = [];
var recv = { toString: function () { log.push('recv'); return 'a-b'; } };
var repl = { toString: function () { log.push('repl'); return '+'; } };
var r = [];
r.push(String.prototype.replace.call(recv, /-/, repl));
r.push(String.prototype.split.call(12321, /2/).join());
r.push(String.prototype.match.call(true, /ru/)[0], String.prototype.search.call(null === null ? 'null' : 0, /l/));
try { String.prototype.replace.call(null, /a/, 'b'); } catch (e) { r.push(e.constructor.name); }
try { 'a'.replaceAll(/a/, 'b'); } catch (e) { r.push(e.constructor.name); }
try { 'a'.matchAll(/a/); } catch (e) { r.push(e.constructor.name); }
r.concat(log).join()
// ---
// Overrides: on the prototype, on an instance, as a getter, a bound intrinsic, a Proxy
// around the intrinsic (with and without an `apply` trap), and the intrinsic moved onto
// an object that is not a RegExp.
var r = [];
var sym = Symbol.replace, intrinsic = RegExp.prototype[sym];
var a = /a/; a[sym] = function (s, t) { return 'own:' + s + t; };
r.push('xa'.replace(a, '!'));
var b = /a/; Object.defineProperty(b, sym, { get: function () { r.push('get'); return intrinsic; } });
r.push('xa'.replace(b, '!'));
var c = /a/; c[sym] = intrinsic.bind(/x/);
r.push('xa'.replace(c, '!'));
var d = /a/; d[sym] = new Proxy(intrinsic, {});
r.push('xa'.replace(d, '!'));
var e = /a/; e[sym] = new Proxy(intrinsic, { apply: function (t, self, args) { r.push('trap'); return Reflect.apply(t, self, args); } });
r.push('xa'.replace(e, '!'));
var o = { exec: function () { r.push('exec'); return null; }, flags: '', global: false };
o[sym] = intrinsic;
r.push('xa'.replace(o, '!'));
var p = {}; p[sym] = intrinsic;
try { 'xa'.replace(p, '!'); } catch (err) { r.push(err.constructor.name); }
var q = /a/; q[Symbol.split] = RegExp.prototype[Symbol.match];
r.push(String('xa'.split(q)));
RegExp.prototype[Symbol.search] = function () { return 'patched'; };
r.push('xa'.search(/a/));
r.join()
// ---
// Throws from inside the in-place call: a replacement function, a user `exec`, a
// `@@species` getter, a `lastIndex` coercion and a `flags` getter, each caught, with the
// state after.
var r = [];
try { 'aa'.replace(/a/g, function () { throw new Error('repl'); }); } catch (e) { r.push(e.message); }
var u = /a/; u.exec = function () { throw new Error('exec'); };
try { 'a'.replace(u, 'b'); } catch (e) { r.push(e.message); }
class S extends RegExp { static get [Symbol.species]() { throw new Error('species'); } }
try { 'a'.split(new S('a')); } catch (e) { r.push(e.message); }
var g = /a/; g.lastIndex = { valueOf: function () { throw new Error('valueOf'); } };
try { 'a'.match(g); } catch (e) { r.push(e.message); }
try { 'a'.replace(g, 'b'); } catch (e) { r.push(e.message); }
var f = /a/; Object.defineProperty(f, 'flags', { get: function () { throw new Error('flags'); } });
try { 'a'.replace(f, 'b'); } catch (e) { r.push(e.message); }
try { [...'a'.matchAll(f)]; } catch (e) { r.push(e.message); }
r.push('after'.replace(/a/, 'A'));
r.join()
// ---
// The callback's view of the call: its `this`, arguments, a stack trace taken inside it,
// and a nest of protocol calls inside callbacks inside protocol calls.
var r = [];
'ab'.replace(/(a)(b)?/, function () { r.push(typeof this, arguments.length, [].slice.call(arguments).join('|')); return ''; });
function inner() { return new Error('t').stack; }
'a'.replace(/a/, function cb() { r.push(inner()); return ''; });
'a-b'.split({ [Symbol.split]: RegExp.prototype[Symbol.split].bind(/-/) }).length;
'a'.replace(/a/, function () { r.push(String('x'.split(/x/, { valueOf: function sv() { return inner().length; } }))); return ''; });
function nest(n) { return n ? 'a'.replace(/a/, function () { return nest(n - 1) + 'x'.split(/y/)[0]; }) : 'z'; }
r.push(nest(20).length);
function deep(n) { return n ? 'q'.replace(/q/, function () { return deep(n - 1); }) : 'end'; }
r.push(deep(30));
r.join()
// ---
// User `exec`, species and lastIndex families mixed, through each protocol.
var r = [], n = 0;
var re = /a/g; re.exec = function (s) { n++; return n < 3 ? { index: 0, 0: 'a', length: 1 } : null; };
r.push('aaa'.replace(re, 'b'), n); n = 0;
r.push(String('aaa'.match(re)), n); n = 0;
class T extends RegExp { static get [Symbol.species]() { r.push('species'); return RegExp; } }
r.push('a-b'.split(new T('-')).join('+'));
var li = /a/; li.lastIndex = { valueOf: function () { r.push('valueOf'); return 0; } };
r.push('aa'.replace(li, 'c'), 'aa'.search(li), String('aa'.match(li)));
r.join()
// ---
// Invariant 8: a value-stack overflow under nests of protocol calls halts where it did,
// at 1, 20 and 40 levels, through `@@replace`, `@@split` and `@@matchAll`.
function deep() { return deep(); }
function f(n) { if (n > 0) 'a'.replace(/a/, function () { f(n - 1); return ''; }); else deep(); }
f(1)
// ---
function deep() { return deep(); }
function f(n) { if (n > 0) 'a'.replace(/a/, function () { f(n - 1); return ''; }); else deep(); }
f(20)
// ---
function deep() { return deep(); }
function f(n) { if (n > 0) 'a'.replace(/a/, function () { f(n - 1); return ''; }); else deep(); }
f(40)
// ---
function deep() { return deep(); }
class R extends RegExp { static get [Symbol.species]() { g(this.n - 1); return RegExp; } }
function g(n) { if (n > 0) { R.n = n; 'a-b'.split(new R('-')); } else deep(); }
R.n = 0; g(30)
// ---
function deep() { return deep(); }
function h(n) { return n > 0 ? [...'aa'.matchAll(/a/g)].map(function () { return h(n - 1); }).length : deep(); }
h(12)
