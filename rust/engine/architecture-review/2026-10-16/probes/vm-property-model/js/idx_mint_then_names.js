// An index-keyed builtin on a 40k array-like, then 30k distinct names.
// 40k + 30k < 64k would fit if indices minted no names (as in XS).
var op = typeof OP === 'undefined' ? 'fill' : OP;
var N = 40000, res = [];
function step(label, f) { try { f(); res.push(label + ':ok'); } catch (e) { res.push(label + ':' + e.name + ' ' + e.message); } }
step('fill', function () { Array.prototype.fill.call({length: N}, 1); });
step('names', function () { var o = {}; for (var i = 0; i < 30000; i++) o['n' + i] = i; });
throw new Error(res.join(' | '));
