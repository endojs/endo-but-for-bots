// JSON.parse of objects with many distinct keys
var parts = [];
for (var i = 0; i < 70000; i++) parts.push('"key' + i + '":' + i);
var text = '{' + parts.join(',') + '}';
var r;
try { r = JSON.parse(text); } catch (e) { throw new Error('caught: ' + e.name + ': ' + e.message); }
throw new Error('done ' + Object.keys(r).length);
