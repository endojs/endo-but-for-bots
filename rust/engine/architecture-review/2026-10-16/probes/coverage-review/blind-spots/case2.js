var out = [];
for (var c = 0xA000; c < 0xB000; c++) {
  var s = String.fromCodePoint(c);
  var a = s.normalize('NFKC'), d = s.normalize('NFKD'), u = s.toUpperCase();
  out.push(c.toString(16) + ':' + Array.from(a).map(x => x.codePointAt(0).toString(16)).join('.') + '/' + Array.from(d).map(x => x.codePointAt(0).toString(16)).join('.'));
}
throw new Error(JSON.stringify(out));
