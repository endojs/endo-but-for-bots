// The t262 CharacterClassEscapes loop shape on N one-code-point strings.
var parts = []; var cps = [];
for (var cp = 0xE000; cp < 0xE000 + NNN; cp++) cps.push(cp);
var str = String.fromCodePoint.apply(null, cps);
var re = /\D/u; var n = 0; var errors = [];
for (const ch of str) { n++; if (!re.test(ch)) errors.push(ch); }
throw new Error("completed " + n + " errors " + errors.length);
