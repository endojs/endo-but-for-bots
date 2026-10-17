var out = [];
function probe(label, make) {
  var lo = 1, hi = 100000;
  function ok(n) { try { Function(make(n)); return true; } catch (e) { if (e instanceof SyntaxError || e instanceof RangeError) return false; throw e; } }
  while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ok(mid)) lo = mid; else hi = mid - 1; }
  out.push(label + "=" + lo);
}
var a = 1, o = { a: null }; o.a = o; function t() { return t; } var p = null;
probe("plus", function (n) { return "a" + "+a".repeat(n - 1); });
probe("strcat", function (n) { return '"x"' + '+"x"'.repeat(n - 1); });
probe("member", function (n) { return "o" + ".a".repeat(n); });
probe("call", function (n) { return "t" + "()".repeat(n); });
probe("optchain", function (n) { return "p" + "?.a".repeat(n); });
probe("logical", function (n) { return "a" + "||a".repeat(n - 1); });
probe("comma", function (n) { return "a" + ",a".repeat(n - 1); });
probe("elseif", function (n) { var s = []; for (var i = 0; i < n; i++) s.push("if (a === " + i + ") a = 1;"); return s.join(" else "); });
probe("ternary", function (n) { return "a?0:".repeat(n) + "1"; });
probe("parens", function (n) { return "(".repeat(n) + "1" + ")".repeat(n); });
probe("array", function (n) { return "[".repeat(n) + "]".repeat(n); });
probe("blocks", function (n) { return "{".repeat(n) + "}".repeat(n); });
probe("funcs", function (n) { return "function f(){".repeat(n) + "}".repeat(n); });
probe("arrows", function (n) { return "x=>".repeat(n) + "1"; });
probe("not", function (n) { return "!".repeat(n) + "1"; });
probe("assign", function (n) { return "a=".repeat(n) + "1"; });
probe("arrpattern", function (n) { return "var " + "[".repeat(n) + "q" + "]".repeat(n) + " = [];"; });
probe("template", function (n) { return "`${".repeat(n) + "1" + "}`".repeat(n); });
throw new Error(out.join(" "));
