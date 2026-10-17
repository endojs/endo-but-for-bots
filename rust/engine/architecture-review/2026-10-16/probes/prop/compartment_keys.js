var out = [];
var c = new Compartment({});
try { c.evaluate('var es = []; for (var i = 0; i < 70000; i++) es.push([i, i]); Object.fromEntries(es);'); out.push('guest ok'); }
catch (e) { out.push('guest: ' + e.name + ': ' + e.message); }
try { var o = JSON.parse('{"hostNeverSeenThisName":1}'); out.push('host json ok ' + o.hostNeverSeenThisName); }
catch (e) { out.push('host json: ' + e.name + ': ' + e.message); }
try { var p = {}; p['dyn' + 'amicHostKey'] = 1; out.push('host dyn ok'); }
catch (e) { out.push('host dyn: ' + e.name + ': ' + e.message); }
try { var s = Symbol('hostsym'); var q = {}; q[s] = 1; out.push('host symbol key ok'); }
catch (e) { out.push('host symbol: ' + e.name + ': ' + e.message); }
try { var m = new Map(); m.set('x', 1); out.push('map ok'); } catch (e) { out.push('map: ' + e.name); }
throw new Error(out.join(' | '));
