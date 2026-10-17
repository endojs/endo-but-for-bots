var START_ = 126976, LIMIT_ = 131072;
var START = typeof START_ === "number" ? START_ : 0; var LIMIT = typeof LIMIT_ === "number" ? LIMIT_ : 0x20000;
var diffs = [];
var h = 0;
for (var c = START; c < LIMIT; c++) {
  if (c >= 0xD800 && c <= 0xDFFF) continue;
  var s = String.fromCodePoint(c);
  var u = s.toUpperCase(), l = s.toLowerCase();
  var targets = [];
  if (Array.from(u).length === 1 && u !== s) targets.push(u);
  if (Array.from(l).length === 1 && l !== s) targets.push(l);
  if (targets.length === 0) continue;
  var esc = '\\u{' + c.toString(16) + '}';
  var reU = new RegExp('^' + esc + '$', 'iu');
  var reB = c < 0x10000 ? new RegExp('^\\u' + ('0000' + c.toString(16)).slice(-4) + '$', 'i') : null;
  var bits = '';
  for (var i = 0; i < targets.length; i++) {
    bits += reU.test(targets[i]) ? '1' : '0';
    if (reB && targets[i].length === 1) bits += reB.test(targets[i]) ? '1' : '0';
  }
  diffs.push(c.toString(16) + ':' + bits);
}
throw new Error(JSON.stringify(diffs));
