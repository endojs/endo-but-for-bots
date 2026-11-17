// 20,000 novel names interned by JSON.parse: no install pass per key.
var parts = [];
for (var j = 0; j < 20000; j++) parts.push('"k' + j + '":' + j);
var o = JSON.parse("{" + parts.join(",") + "}");
