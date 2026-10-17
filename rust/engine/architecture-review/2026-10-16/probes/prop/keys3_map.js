// Map keys do not consume property-key ids
var m = new Map();
for (var i = 0; i < 100000; i++) m.set('k' + i, i);
var o = {}; o['afterMap'] = 1;
throw new Error('done ' + m.size + ' ' + o.afterMap);
