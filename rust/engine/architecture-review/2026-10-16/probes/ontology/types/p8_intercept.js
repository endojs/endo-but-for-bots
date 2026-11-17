var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('re_own_source', function(){ var r = /a/g; Object.defineProperty(r, 'source', {value: 'own'}); return r.source + ' ' + r['source'] + ' ' + Reflect.get(r, 'source'); });
t('re_own_flags', function(){ var r = /a/g; Object.defineProperty(r, 'flags', {value: 'own'}); return r.flags + ' ' + r['flags']; });
t('re_own_global', function(){ var r = /a/g; Object.defineProperty(r, 'global', {value: 'own'}); return String(r.global) + ' ' + String(r['global']); });
t('re_proto_override', function(){ var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags'); Object.defineProperty(RegExp.prototype, 'flags', {get: function(){ return 'patched'; }, configurable: true}); var r = /a/g; var res = r.flags + ' ' + r['flags']; Object.defineProperty(RegExp.prototype, 'flags', d); return res; });
t('re_proto_delete_global', function(){ var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'global'); delete RegExp.prototype.global; var r = /a/g; var res = String(r.global) + ' ' + String(r['global']); Object.defineProperty(RegExp.prototype, 'global', d); return res; });
t('re_subclass', function(){ class R extends RegExp { get flags() { return 'sub'; } } var r = new R('a', 'g'); return r.flags + ' ' + r['flags']; });
t('re_flags_generic', function(){ var r = /a/gi; Object.defineProperty(r, 'global', {value: false}); return r.flags; });
t('locale_own', function(){ var l = new Intl.Locale('en-US'); Object.defineProperty(l, 'language', {value: 'own'}); return l.language + ' ' + l['language']; });
t('locale_proto', function(){ Object.defineProperty(Intl.Locale.prototype, 'region', {get: function(){ return 'patched'; }, configurable: true}); var l = new Intl.Locale('en-US'); return l.region + ' ' + l['region']; });
t('collator_compare_own', function(){ var c = new Intl.Collator(); Object.defineProperty(c, 'compare', {value: 'own'}); return String(c.compare) + ' ' + String(c['compare']); });
t('fn_length_own', function(){ function f(a,b){} Object.defineProperty(f, 'length', {value: 9}); return String(f.length) + ' ' + String(f['length']); });
throw new Error(JSON.stringify(out));
