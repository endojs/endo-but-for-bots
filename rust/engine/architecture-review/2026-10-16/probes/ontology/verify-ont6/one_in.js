var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('in', function(){ var r = /ab/gi; return [String('flags' in r), String('source' in r), String('global' in r)].join('|'); });
throw new Error(JSON.stringify(out));
