// Compare the lexer's identifier tables with the regexp engine's \p{ID_Start}/\p{ID_Continue}.
var startRe = /^\p{ID_Start}$/u, contRe = /^\p{ID_Continue}$/u;
var d1 = [], d2 = [], d3 = [], d4 = [];
function lexStart(ch) { try { Function("var " + ch + ";"); return true; } catch (e) { return false; } }
function lexCont(ch) { try { Function("var a" + ch + ";"); return true; } catch (e) { return false; } }
for (var c = 0x80; c <= 0x10FFFF; c++) {
  if (c >= 0xD800 && c <= 0xDFFF) continue;
  var ch = String.fromCodePoint(c);
  var rs = startRe.test(ch), rc = contRe.test(ch);
  if (!rs && !rc && (c & 0xFF) !== 0) continue; // sample non-ID chars sparsely
  var ls = lexStart(ch);
  if (rs !== ls) (rs ? d1 : d2).push(c.toString(16));
  if (rc) { var lc = lexCont(ch); if (!lc) d3.push(c.toString(16)); }
}
throw new Error(JSON.stringify({ regexpStartButLexerNot: d1.length, ex1: d1.slice(0, 8), lexerStartButRegexpNot: d2.length, ex2: d2.slice(0, 8), regexpContButLexerNot: d3.length, ex3: d3.slice(0, 8) }));
