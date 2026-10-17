var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('replace_subclass', function(){ class R extends RegExp { get flags(){ return 'g'; } } var r = new R('a'); return 'aaa'.replace(r, 'b'); });
throw new Error(JSON.stringify(out));
