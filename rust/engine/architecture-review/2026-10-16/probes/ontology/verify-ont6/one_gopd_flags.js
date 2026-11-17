var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('gopd_flags', function(){ var d = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags'); return d ? typeof d.get : 'none'; });
throw new Error(JSON.stringify(out));
