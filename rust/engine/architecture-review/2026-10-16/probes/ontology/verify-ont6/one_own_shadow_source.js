var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('own_shadow_source', function(){ var r = /a/; Object.defineProperty(r, 'source', {value: 'own'}); return r.source + ' ' + r['source']; });
throw new Error(JSON.stringify(out));
