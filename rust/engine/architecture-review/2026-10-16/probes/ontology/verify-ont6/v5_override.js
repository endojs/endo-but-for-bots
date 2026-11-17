var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('re_proto_override', function(){ Object.defineProperty(RegExp.prototype, 'flags', {get: function(){ return 'patched'; }, configurable: true}); var r = /a/g; return [r.flags, r['flags'], Reflect.get(r, 'flags'), String(r)].join(' '); });
t('locale_own', function(){ var l = new Intl.Locale('en-US'); Object.defineProperty(l, 'language', {value: 'own'}); return l.language + ' ' + l['language']; });
throw new Error(JSON.stringify(out));
