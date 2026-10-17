var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('proto_flags', function(){ return String(RegExp.prototype.flags); });
throw new Error(JSON.stringify(out));
