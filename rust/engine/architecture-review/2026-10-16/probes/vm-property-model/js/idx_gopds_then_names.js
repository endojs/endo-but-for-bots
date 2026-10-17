var N = 40000, res = [];
function step(label, f) { try { f(); res.push(label + ':ok'); } catch (e) { res.push(label + ':' + e.name + ' ' + e.message); } }
step('gopds', function () { Object.getOwnPropertyDescriptors(new Uint8Array(N)); });
step('json', function () { var p = []; for (var i = 0; i < 30000; i++) p.push('"n' + i + '":1'); JSON.parse('{' + p.join(',') + '}'); });
throw new Error(res.join(' | '));
