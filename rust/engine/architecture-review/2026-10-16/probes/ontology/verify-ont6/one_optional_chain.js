var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('optional_chain', function(){ var r = /ab/gi; return String(r?.flags); });
throw new Error(JSON.stringify(out));
