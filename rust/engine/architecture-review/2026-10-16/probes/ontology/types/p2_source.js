function u(s){ if (typeof s !== 'string') return typeof s + ':' + String(s); var r=[]; for (var i=0;i<s.length;i++){ var c=s.charCodeAt(i); r.push(c<0x80 && c>=0x20 && c!==0x2c ? String.fromCharCode(c) : 'U+'+c.toString(16)); } return r.join(','); }
var out = {};
function t(name, f){ try { out[name] = u(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + u(String(e && e.message)); } }
t('eval_literal', function(){ return eval("'\uD800'"); });
t('eval_literal_trail', function(){ return eval("'x\uDC00y'"); });
t('indirect_eval', function(){ return (0, eval)("'\uD800'"); });
t('function_ctor_body', function(){ return new Function("return '\uD800'")(); });
t('function_ctor_toString', function(){ var f = new Function("return '\uD800'"); var s = f.toString(); return String(s.indexOf('\uD800') >= 0) + ' ' + String(s.indexOf('�') >= 0); });
t('fn_toString_decl', function(){ var f = eval("(function g(){ return '\uDC00'; })"); var s = f.toString(); return String(s.indexOf('\uDC00') >= 0) + ' ' + String(s.indexOf('�') >= 0); });
t('template_raw', function(){ return eval("String.raw`\uD800`"); });
t('template_cooked', function(){ return eval("`a\uD800`"); });
t('regex_literal_src', function(){ return eval("/\uD800/").source; });
t('regex_literal_test', function(){ return String(eval("/\uD800/").test('\uD800')); });
t('comment', function(){ return String(eval("1 // \uD800\n")); });
t('ident_err', function(){ try { eval("var \uD800 = 1"); return 'no error'; } catch(e){ return e.name; } });
t('prop_name_source', function(){ var o = eval("({'\uD800': 1})"); return Object.keys(o).map(u).join('|'); });
t('prop_name_source_vs_runtime', function(){ var o = eval("({'\uD800': 1})"); return String(o['\uD800']); });
t('json_in_eval', function(){ return eval("JSON.parse('\"\\\\ud800\"')"); });
throw new Error(JSON.stringify(out));
