var res = [];
function step(label, f) { try { f(); res.push(label + ':ok'); } catch (e) { res.push(label + ':' + e.name + ' ' + e.message); } }
step('names', function () { var o = {}; for (var i = 0; i < 30000; i++) o['n' + i] = i; });
step('names2', function () { var o = {}; for (var i = 0; i < 30000; i++) o['m' + i] = i; });
throw new Error(res.join(' | '));
