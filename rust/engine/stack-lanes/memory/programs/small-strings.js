// Many small strings: N kept strings of 1,024 code units (2 KiB of chunk
// each), so the chunk arena fills without any large temporary copy.
var kept = [];
for (var i = 0; i < __N__; i++) kept.push(String(i).padStart(1024, 'x'));
kept.length
