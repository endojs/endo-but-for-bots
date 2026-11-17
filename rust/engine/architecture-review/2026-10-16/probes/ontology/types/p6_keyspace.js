var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
t('many_keys', function(){ var o = {}; for (var i = 0; i < 70000; i++) o['k' + i] = i; return String(Object.keys(o).length) + ' ' + o.k69999 + ' ' + o.k5; });
t('many_syms', function(){ var o = {}; var s = []; for (var i = 0; i < 1000; i++) { s.push(Symbol('s'+i)); o[s[i]] = i; } return String(Object.getOwnPropertySymbols(o).length); });
throw new Error(JSON.stringify(out));
