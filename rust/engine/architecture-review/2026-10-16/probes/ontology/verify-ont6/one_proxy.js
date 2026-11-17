var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('proxy', function(){ var p = new Proxy(/a/g, {}); return String(p.flags) + ' ' + String(p.global); });
throw new Error(JSON.stringify(out));
