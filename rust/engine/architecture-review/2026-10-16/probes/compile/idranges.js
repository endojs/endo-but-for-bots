function ranges(re) {
  var out = [], start = -1;
  for (var c = 0; c <= 0x110000; c++) {
    var m = c <= 0x10FFFF && !(c >= 0xD800 && c <= 0xDFFF) && re.test(String.fromCodePoint(c));
    if (m && start < 0) start = c;
    if (!m && start >= 0) { out.push(start + "-" + (c - 1)); start = -1; }
  }
  return out.join(",");
}
throw new Error("START " + ranges(/^\p{ID_Start}$/u) + " CONT " + ranges(/^\p{ID_Continue}$/u));
