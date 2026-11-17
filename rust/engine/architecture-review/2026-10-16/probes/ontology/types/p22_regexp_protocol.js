var out = {};
function t(name, f){ try { out[name] = JSON.stringify(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
class G extends RegExp { get flags() { return 'g'; } }
class NG extends RegExp { get flags() { return ''; } }
t('replaceAll_flags_override', function(){ return 'aa'.replaceAll(new G('a'), 'b'); });
t('replaceAll_flags_override_throw', function(){ return 'aa'.replaceAll(new NG('a', 'g'), 'b'); });
t('matchAll_flags_override', function(){ return [...'aa'.matchAll(new G('a'))].length; });
t('replace_symbol_flags', function(){ return 'aa'.replace(new G('a'), 'b'); });
t('split_flags_override', function(){ class Y extends RegExp { get flags() { return 'y'; } } return 'a,b'.split(new Y(',')); });
t('generic_flags_getter', function(){ var g = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags'); return g ? g.get.call({hasIndices: true, global: true, unicode: true}) : 'no accessor'; });
t('source_of_proto', function(){ return RegExp.prototype.source; });
t('flags_of_proto', function(){ return RegExp.prototype.flags; });
t('global_of_proto', function(){ return String(RegExp.prototype.global); });
t('tostring_generic', function(){ return RegExp.prototype.toString.call({source: 'x', flags: 'y'}); });
throw new Error(JSON.stringify(out));
