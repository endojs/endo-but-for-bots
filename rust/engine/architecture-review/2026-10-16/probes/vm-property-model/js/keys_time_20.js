var parts = []; for (var i = 0; i < 20000; i++) parts.push('"key_number_' + i + '":' + i);
var o = JSON.parse('{' + parts.join(',') + '}');
var n = 0; for (var r = 0; r < 20; r++) { var ks = Object.keys(o); n += ks.length; }
