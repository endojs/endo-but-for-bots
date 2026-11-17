var out = []; var log = function (s) { out.push(s); };
function t(label, f) { try { f(); log(label + ' no-throw'); } catch (e) { log(label + ' ' + e.name); } }
var scope = { x: 1 };
t('case1', function () { with (scope) { (function(){ 'use strict'; x = (delete scope.x, 2); })(); } });
log('  x in scope=' + ('x' in scope));
var s2 = { get x() { delete s2.x; return 1; }, };
t('case2', function () { with (s2) { (function(){ 'use strict'; x += 1; })(); } });
log('  x in s2=' + ('x' in s2));
t('case3-sloppy', function () { var s = {x:1}; with (s) { x = (delete s.x, 2); } log('  sloppy x in s=' + ('x' in s)); });
t('case4', function () { (function(){ 'use strict'; undeclared1 = (globalThis.undeclared1 = 5); })(); });
// GetBindingValue strict: binding deleted between HasBinding and Get
var s5 = { y: 1 };
t('case5-get', function () { with (s5) { (function(){ 'use strict'; var r = (delete s5.y, 0) + y; log('  r=' + r); })(); } });
// Proxy trap count
var traps = [];
var p = new Proxy({z:1}, { has(t,k){ traps.push('has:'+String(k)); return k in t; }, get(t,k,r){ if (k !== Symbol.unscopables) traps.push('get:'+String(k)); else traps.push('get:@@unscopables'); return t[k]; } });
with (p) { z; }
log('trap6 ' + traps.join(','));
traps = [];
var p2 = new Proxy({z:1}, { has(t,k){ traps.push('has:'+String(k)); return k in t; }, set(t,k,v){ traps.push('set:'+String(k)); t[k]=v; return true; }, get(t,k){ traps.push('get:'+(typeof k==='symbol'?'@@':'')+String(k.description||k)); return t[k]; } });
with (p2) { z = 2; }
log('trap7 ' + traps.join(','));
throw new Error("RESULT " + out.join(" | "));
