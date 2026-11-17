var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('dot', function(){ var r = /ab/gi; return [r.flags, r.source, String(r.global), String(r.sticky)].join('|'); });
throw new Error(JSON.stringify(out));
