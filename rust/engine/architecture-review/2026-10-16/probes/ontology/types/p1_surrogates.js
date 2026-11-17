function u(s){ if (typeof s !== 'string') return typeof s + ':' + String(s); var r=[]; for (var i=0;i<s.length;i++){ var c=s.charCodeAt(i); r.push(c<0x80 && c>=0x20 && c!==0x2c ? String.fromCharCode(c) : 'U+'+c.toString(16)); } return r.join(','); }
var out = {};
function t(name, f){ try { out[name] = u(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + u(String(e && e.message)); } }
// property keys
t('key_lone_distinct', function(){ var o={}; o['\uD800']=1; o['�']=2; o['\uDC00']=3; return Object.keys(o).map(u).join('|'); });
t('key_lone_get', function(){ var o={}; o['\uD800']=1; return String(o['�']) + '/' + String(o['\uD800']); });
t('key_lone_pair_split', function(){ var o={}; o['😀']=1; o['\uD83D']=2; o['\uDE00']=3; return Object.keys(o).map(u).join('|'); });
t('key_in', function(){ var o={'\uD800':1}; return String('�' in o); });
t('key_defineProperty', function(){ var o={}; Object.defineProperty(o, '\uD800', {value:1, enumerable:true}); return Object.getOwnPropertyNames(o).map(u).join('|'); });
t('global_key', function(){ globalThis['\uD800g']=5; return String(globalThis['�g']) + '/' + String(globalThis['\uD800g']); });
// symbols
t('sym_desc', function(){ return Symbol('\uD800').description; });
t('sym_toString', function(){ return Symbol('\uD800').toString(); });
t('sym_for_distinct', function(){ return String(Symbol.for('\uD800') === Symbol.for('�')); });
t('sym_keyFor', function(){ return Symbol.keyFor(Symbol.for('\uD800')); });
t('sym_for_desc', function(){ return Symbol.for('\uDC00x').description; });
// errors
t('err_msg', function(){ return new Error('\uD800').message; });
t('err_toString', function(){ return String(new Error('a\uD800b')); });
t('err_stack_free', function(){ var e = new TypeError('\uDC00'); return e.message; });
t('err_engine_msg', function(){ try { null['\uD800zz']; } catch(e){ return String(e.message.indexOf('\uD800') >= 0) + ' ' + u(e.message); } return 'none'; });
t('err_engine_msg2', function(){ try { var f = {}; f['q\uD800'](); } catch(e){ return String(e.message.indexOf('\uD800') >= 0) + ' ' + u(e.message); } return 'none'; });
// JSON
t('json_stringify', function(){ return JSON.stringify('\uD800'); });
t('json_stringify_key', function(){ var o={}; o['\uDC00']=1; return JSON.stringify(o); });
t('json_parse', function(){ return JSON.parse('"\\ud800"'); });
t('json_parse_raw', function(){ return JSON.parse('"\uD800"'); });
t('json_parse_key', function(){ return Object.keys(JSON.parse('{"\\udc00":1}'))[0]; });
// regexp
t('re_source', function(){ return new RegExp('\uD800').source; });
t('re_test', function(){ return String(new RegExp('\uD800').test('\uD800')) + String(new RegExp('\uD800').test('�')); });
t('re_u_test', function(){ return String(new RegExp('\uD800', 'u').test('\uD800')) + String(new RegExp('\uD800','u').test('�')); });
t('re_toString', function(){ return String(new RegExp('a\uDC00')); });
t('re_exec', function(){ return /./.exec('\uD800')[0]; });
t('re_replace', function(){ return '\uD800'.replace(/x/, 'y'); });
t('re_replace2', function(){ return 'ab'.replace(/a/, '\uD800'); });
t('re_split', function(){ return 'a\uD800b'.split(/b/)[0]; });
throw new Error(JSON.stringify(out));
