// control: delete+set churn on a 30-key object (below index threshold), 4000 ops
var o = {}; var ks = []; for (var i = 0; i < 30; i++) { ks.push('k' + i); o['k' + i] = i; }
for (var i = 0; i < 4000; i++) { var k = ks[i % 30]; delete o[k]; o[k] = i; }
