// String-dominated: N kept strings of 2^20 code units (2 MiB of chunk each),
// each a different two-unit pattern repeated, so that each is one allocation
// and no two are alike.
var kept = [];
for (var i = 0; i < __N__; i++) {
  kept.push(String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26)).repeat(1 << 19));
}
kept.length
