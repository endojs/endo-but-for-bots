const out = [];
// mapped arguments
(function (a, b) { arguments[0] = 'A'; b = 'B'; out.push(a, arguments[1], arguments.length); })(1, 2);
// unmapped in strict
(function (a) { 'use strict'; arguments[0] = 'A'; out.push(a); })(1);
// mapped arguments with default param is unmapped
(function (a = 0) { arguments[0] = 'A'; out.push(a); })(1);
// delete then re-add breaks mapping
(function (a) { delete arguments[0]; arguments[0] = 'Z'; out.push(a); })(1);
// with + function call receiver
var o = { v: 1, m() { return this === o; } };
with (o) { out.push(v, m()); }
// direct eval this / new.target
function F() { return eval('this'); }
out.push(F.call(o) === o);
function G() { return eval('new.target'); }
out.push(new G() instanceof G ? 'obj' : 'nt');
// indirect eval sees global var, not local
var gv = 'global';
(function () { var gv = 'local'; out.push((0, eval)('gv'), eval('gv')); })();
// direct eval var leaks into sloppy function scope
(function () { eval('var leaked = 5'); out.push(typeof leaked); })();
(function () { 'use strict'; eval('var leaked2 = 5'); out.push(typeof leaked2); })();
// Annex B.3.3: function in block in sloppy mode hoists var binding
(function () { out.push(typeof bf); { function bf() {} } out.push(typeof bf); })();
// closures in loop: per-iteration bindings
const fs = []; for (let i = 0; i < 3; i++) fs.push(function () { return i; }); out.push(fs.map(function (f) { return f(); }).join(''));
throw new Error(JSON.stringify(out));
