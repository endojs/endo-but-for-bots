// An ownKeys trap result is a list of strings to compare, not properties to create.
var keys = []; for (var i = 0; i < 40000; i++) keys.push('t' + i);
var p = new Proxy({}, { ownKeys: function () { return keys; } });
var res = [];
try { res.push('ownKeys:' + Reflect.ownKeys(p).length); } catch (e) { res.push('ownKeys threw ' + e.name); }
try { var o = {}; for (var i = 0; i < 30000; i++) o['n' + i] = i; res.push('names:ok'); } catch (e) { res.push('names threw ' + e.name + ' ' + e.message); }
throw new Error(res.join(' | '));
