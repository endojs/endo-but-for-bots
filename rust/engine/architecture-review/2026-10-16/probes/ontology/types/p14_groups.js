function u(s){ if (typeof s !== 'string') return typeof s + ':' + String(s); var r=[]; for (var i=0;i<s.length;i++){ var c=s.charCodeAt(i); r.push(c<0x80 && c>=0x20 && c!==0x2c ? String.fromCharCode(c) : 'U+'+c.toString(16)); } return r.join(''); }
var out = {};
function t(name, f){ try { out[name] = u(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + u(String(e && e.message)); } }
t('astral_group_u', function(){ var m = new RegExp('(?<\u{1d4b3}>a)', 'u').exec('a'); return Object.keys(m.groups).map(u).join('|') + '=' + m.groups['\u{1d4b3}']; });
t('astral_group_escape', function(){ var m = new RegExp('(?<\\u{1d4b3}>a)', 'u').exec('a'); return Object.keys(m.groups).map(u).join('|'); });
t('astral_group_nonu', function(){ var m = new RegExp('(?<\\ud835\\udcb3>a)').exec('a'); return Object.keys(m.groups).map(u).join('|'); });
t('replace_named', function(){ return 'a'.replace(new RegExp('(?<\u{1d4b3}>a)', 'u'), '[$<\u{1d4b3}>]'); });
t('astral_ident_global', function(){ eval('var \u{1d4b3} = 7;'); return String(globalThis['\u{1d4b3}']) + ' ' + Object.keys(globalThis).filter(function(k){ return k.length === 2 && k.charCodeAt(0) === 0xd835; }).map(u).join('|'); });
t('astral_prop_dot', function(){ var o = eval('({ \u{1d4b3}: 1 })'); return Object.keys(o).map(u).join('|') + ' ' + String(o['\u{1d4b3}']); });
t('astral_escaped_ident', function(){ var o = eval('({ \\u{1d4b3}: 2 })'); return Object.keys(o).map(u).join('|') + ' ' + String(o['\u{1d4b3}']); });
t('fn_name_astral', function(){ var f = eval('(function \u{1d4b3}(){})'); return f.name; });
t('class_name_astral', function(){ var C = eval('(class \u{1d4b3} {})'); return C.name; });
t('private_astral', function(){ var C = eval('(class { #\u{1d4b3} = 3; get(){ return this.#\u{1d4b3}; } })'); return String(new C().get()); });
t('nul_key', function(){ var o = {}; o['a\0b'] = 1; o['a'] = 2; return Object.keys(o).map(u).join('|'); });
t('nul_ident_key_vs_string', function(){ var o = eval('({ "x\\0": 1 })'); return Object.keys(o).map(u).join('|') + String(o['x\0']); });
t('symbol_for_nul', function(){ return String(Symbol.for('a\0') === Symbol.for('a')) + String(Symbol.keyFor(Symbol.for('a\0')).length); });
t('symbol_for_astral', function(){ return Symbol.keyFor(Symbol.for('\u{1d4b3}')); });
t('json_parse_astral_key', function(){ return Object.keys(JSON.parse('{"\\ud835\\udcb3":1, "\\ud835":2}')).map(u).join('|'); });
t('error_name_astral', function(){ var e = new Error('m'); e.name = '\u{1d4b3}\uD800'; return String(e); });
t('fn_name_lone', function(){ var o = { ['\uD800']: function(){} }; return o['\uD800'].name; });
t('fn_name_symbol_lone', function(){ var o = { [Symbol('\uDC00')]: function(){} }; return o[Object.getOwnPropertySymbols(o)[0]].name; });
t('bound_name_lone', function(){ var o = { ['\uD800']: function(){} }; return o['\uD800'].bind().name; });
t('getter_name_lone', function(){ var o = { get ['\uD800']() { return 1; } }; return Object.getOwnPropertyDescriptor(o, '\uD800').get.name; });
t('class_static_name_lone', function(){ var C = class { static ['\uD800']() {} }; return C['\uD800'].name; });
throw new Error(JSON.stringify(out));
