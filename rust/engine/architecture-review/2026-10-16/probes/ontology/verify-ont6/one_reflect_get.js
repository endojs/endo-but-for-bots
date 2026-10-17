var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('reflect_get', function(){ var r = /ab/gi; return [String(Reflect.get(r, 'flags')), String(Reflect.get(r, 'source')), String(Reflect.get(r, 'global'))].join('|'); });
throw new Error(JSON.stringify(out));
