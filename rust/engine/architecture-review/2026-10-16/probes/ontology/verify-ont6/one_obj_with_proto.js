var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('obj_with_proto', function(){ var o = Object.create(/a/g); return String(o.global) + ' ' + String(o.flags); });
throw new Error(JSON.stringify(out));
