var out = []; var log = function (s) { out.push(s); };
function t(label, f) { try { var r = f(); log(label + ' no-throw r=' + r); } catch (e) { log(label + ' ' + e.name); } }
// GetBindingValue step: binding deleted inside @@unscopables getter (between HasBinding's HasProperty and GetBindingValue)
var env = { x: 1 };
Object.defineProperty(env, Symbol.unscopables, { get: function () { delete env.x; return undefined; }, configurable: true });
t('get-strict', function () { with (env) { return (function(){ 'use strict'; return x; })(); } });
var env2 = { x: 1 };
Object.defineProperty(env2, Symbol.unscopables, { get: function () { delete env2.x; return undefined; }, configurable: true });
t('get-sloppy', function () { with (env2) { return x; } });
var env3 = { x: 1 };
Object.defineProperty(env3, Symbol.unscopables, { get: function () { delete env3.x; return undefined; }, configurable: true });
t('set-strict', function () { with (env3) { (function(){ 'use strict'; x = 2; })(); } return 'x in env3=' + ('x' in env3); });
throw new Error("RESULT " + out.join(" | "));
