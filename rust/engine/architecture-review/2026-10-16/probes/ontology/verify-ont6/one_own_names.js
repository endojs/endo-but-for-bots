var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('own_names', function(){ return Object.getOwnPropertyNames(RegExp.prototype).sort().join(','); });
throw new Error(JSON.stringify(out));
