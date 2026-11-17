// control: same object/keys as queue_8000 but overwrite existing keys (no delete)
var parts = []; for (var i = 0; i < 8000; i++) parts.push('"k' + i + '":' + i);
var o = JSON.parse('{' + parts.join(',') + '}'); var ks = Object.keys(o);
for (var i = 0; i < 4000; i++) { o[ks[i]] = o[ks[i]] + 1; }
