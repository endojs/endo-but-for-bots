var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('names', function(){ return Object.getOwnPropertyNames(RegExp.prototype).join(','); });
t('flags_desc', function(){ var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags'); return d ? Object.keys(d).join('/') + ' ' + typeof d.get : 'none'; });
t('global_desc', function(){ var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'global'); return d ? Object.keys(d).join('/') + ' ' + typeof d.get : 'none'; });
t('flags_getter_call', function(){ var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags'); return d.get.call({global: true, sticky: true}); });
t('reflect_get_flags', function(){ return Reflect.get(/a/gm, 'flags'); });
t('reflect_get_proto_flags', function(){ return String(Reflect.get(RegExp.prototype, 'flags')); });
t('proto_override2', function(){ Object.defineProperty(RegExp.prototype, 'flags', {get: function(){ return 'patched'; }, configurable: true}); var r = /a/g; return r.flags + ' ' + r['flags'] + ' ' + Reflect.get(r, 'flags'); });
throw new Error(JSON.stringify(out));
