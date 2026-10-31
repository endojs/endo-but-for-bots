// Same names, interned first by JSON.parse; then one computed write per key.
var parts = [];
for (var j = 0; j < 20000; j++) parts.push('"k' + j + '":' + j);
var o = JSON.parse("{" + parts.join(",") + "}");
var p = {};
for (var i = 0; i < 20000; i++) p["k" + i] = i;
