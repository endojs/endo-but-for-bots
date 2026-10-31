var res = [];
function step(label, f) { try { f(); res.push(label + ':ok'); } catch (e) { res.push(label + ':' + e.name + ' ' + e.message); } }
// each mints 20000 index names if indices are interned; 4 x 20000 > 64k
step('reflect.set', function () { var o = {}; for (var i = 0; i < 20000; i++) Reflect.set(o, i, 1); });
step('defineProperty', function () { var o = {}; for (var i = 20000; i < 40000; i++) Object.defineProperty(o, i, {value:1}); });
step('proxy set', function () { var p = new Proxy({}, {}); for (var i = 40000; i < 60000; i++) p[i] = 1; });
step('map expando', function () { var m = new Map(); for (var i = 60000; i < 80000; i++) m[i] = 1; });
step('plain names', function () { var o = {}; for (var i = 0; i < 5000; i++) o['z' + i] = 1; });
throw new Error(res.join(' | '));
