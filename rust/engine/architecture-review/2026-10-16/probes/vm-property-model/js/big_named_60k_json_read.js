var parts = []; for (var i = 0; i < 60000; i++) parts.push('"k' + i + '":' + i);
var o = JSON.parse('{' + parts.join(',') + '}');
var ks = Object.keys(o);
