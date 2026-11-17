var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('proto_global', function(){ return String(RegExp.prototype.global); });
throw new Error(JSON.stringify(out));
