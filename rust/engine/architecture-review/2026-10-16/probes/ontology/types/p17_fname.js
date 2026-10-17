function u(s){ if (typeof s !== 'string') return typeof s + ':' + String(s); var r=[]; for (var i=0;i<s.length;i++){ var c=s.charCodeAt(i); r.push(c<0x80 && c>=0x20 && c!==0x2c ? String.fromCharCode(c) : 'U+'+c.toString(16)); } return r.join(''); }
var out = {};
function t(name, f){ try { out[name] = u(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + u(String(e && e.message)); } }
var o = {['\uD800']: function(){}, ['a\\ud800']: function(){}, ['�']: function(){}, ['q"r']: function(){}};
t('lone_name', function(){ return o['\uD800'].name; });
t('lone_toString', function(){ return o['\uD800'].toString(); });
t('backslash_toString', function(){ return o['a\\ud800'].toString(); });
t('fffd_toString', function(){ return o['�'].toString(); });
t('quote_toString', function(){ return o['q"r'].toString(); });
t('sym_toString', function(){ var p = {[Symbol('\uDC00')]: function(){}}; return p[Object.getOwnPropertySymbols(p)[0]].toString(); });
t('bound_toString', function(){ return o['\uD800'].bind().toString(); });
t('renamed', function(){ var f = function g(){}; Object.defineProperty(f, 'name', {value: 'renamed'}); return f.toString(); });
t('class_lone', function(){ var C = {['\uD800']: class {}}['\uD800']; return C.name + ' / ' + C.toString(); });
throw new Error(JSON.stringify(out));
