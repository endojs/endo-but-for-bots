// The harness's buildString for \P{ASCII}: every code point 0x80..0x10FFFF.
let s = "";
const parts = [];
for (let cp = 0x80; cp <= 0x10FFFF; cp += 1) { if (cp < 0xD800 || cp > 0xDFFF) parts.push(cp); if (parts.length === 10000) { s += String.fromCodePoint(...parts); parts.length = 0; } }
s += String.fromCodePoint(...parts);
throw new Error("len " + s.length);
