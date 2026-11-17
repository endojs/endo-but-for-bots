var N = 40000, res = [];
function step(label, f) { try { f(); res.push(label + ':ok'); } catch (e) { res.push(label + ':' + e.name + ' ' + e.message); } }
step('reflect.set', function () { var o = {}; for (var i = 0; i < N; i++) Reflect.set(o, i, i); });
step('sym', function () { for (var i = 0; i < 30000; i++) { var o = {}; o[Symbol()] = 1; } });
throw new Error(res.join(' | '));
