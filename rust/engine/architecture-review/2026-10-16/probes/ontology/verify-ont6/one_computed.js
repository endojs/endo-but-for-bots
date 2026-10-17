var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('computed', function(){ var r = /ab/gi; var k = 'flags', s = 'source', g = 'global'; return [String(r[k]), String(r[s]), String(r[g])].join('|'); });
throw new Error(JSON.stringify(out));
