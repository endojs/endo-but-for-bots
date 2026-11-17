// Per-block digest of toUpperCase/toLowerCase/normalize over all code points.
var OPS = ['U','L','NFC','NFD','NFKC','NFKD'];
var op = OPS.indexOf(typeof OPNAME === 'string' ? OPNAME : 'U');
function apply(s, k) {
  switch (k) { case 0: return s.toUpperCase(); case 1: return s.toLowerCase(); case 2: return s.normalize('NFC'); case 3: return s.normalize('NFD'); case 4: return s.normalize('NFKC'); default: return s.normalize('NFKD'); }
}
var out = [];
for (var k = 0; k < 6; k++) {
  var blocks = [];
  for (var b = 0; b < 0x110; b++) {
    var h = 0;
    for (var c = b * 0x1000; c < (b + 1) * 0x1000; c++) {
      if (c >= 0xD800 && c <= 0xDFFF) continue;
      var r = apply(String.fromCodePoint(c), k);
      for (var i = 0; i < r.length; i++) h = (Math.imul(h, 31) + r.charCodeAt(i)) | 0;
      h = (Math.imul(h, 31) + 7) | 0;
    }
    blocks.push(h);
  }
  out.push(blocks);
}
throw new Error(JSON.stringify(out));
