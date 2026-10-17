var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('own_global_flags', function(){ var r = /a/gi; Object.defineProperty(r, 'global', {value: false}); return r.flags; });
throw new Error(JSON.stringify(out));
