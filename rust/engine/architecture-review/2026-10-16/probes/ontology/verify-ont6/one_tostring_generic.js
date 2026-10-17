var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('tostring_generic', function(){ return RegExp.prototype.toString.call({source: 'x', flags: 'y'}); });
throw new Error(JSON.stringify(out));
