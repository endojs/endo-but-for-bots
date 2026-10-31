var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('proto_source', function(){ return String(RegExp.prototype.source); });
throw new Error(JSON.stringify(out));
