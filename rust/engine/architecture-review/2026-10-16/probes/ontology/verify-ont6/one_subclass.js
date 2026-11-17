var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('subclass', function(){ class R extends RegExp { get flags(){ return 'sub'; } } var r = new R('a','g'); var k='flags'; return r.flags + ' ' + r[k]; });
throw new Error(JSON.stringify(out));
