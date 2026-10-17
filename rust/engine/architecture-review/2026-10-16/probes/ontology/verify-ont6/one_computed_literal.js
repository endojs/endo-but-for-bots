var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('computed_literal', function(){ var r = /ab/gi; return [String(r['flags']), String(r['source'])].join('|'); });
throw new Error(JSON.stringify(out));
