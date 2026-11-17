var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('destructure', function(){ var {flags, source, global} = /ab/gi; return [String(flags), String(source), String(global)].join('|'); });
throw new Error(JSON.stringify(out));
