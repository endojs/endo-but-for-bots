var out = [];
function c(name, f) { var r; try { r = JSON.stringify(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("gen-yield-in-try-from-callback", function () { function* g() { try { yield 1; yield 2; } finally { out2.push("fin"); } } var out2 = []; var it = g(); [0, 1].forEach(function () { out2.push(it.next().value); }); out2.push(it.return(9).value); return out2; });
c("throw-through-gen-in-callback", function () { function* g() { try { yield 1; throw new Error("boom"); } catch (e) { yield "caught " + e.message; } } var it = g(); var r = []; [0, 1].map(function () { r.push(it.next().value); }); return r; });
c("callback-return-in-finally", function () { return [1, 2].map(function (x) { try { throw x; } finally { return x * 10; } }); });
c("callback-break-label-finally", function () { var r = []; [1].forEach(function () { a: { try { break a; } finally { r.push("f"); } } r.push("after"); }); return r; });
c("sort-comparator-throw", function () { try { [3, 1, 2].sort(function () { throw "cmp"; }); } catch (e) { return e; } });
c("getter-throw-in-for-of-in-gen", function () { var o = { get x() { throw "g"; } }; function* g() { for (var v of [1]) { try { yield o.x; } catch (e) { yield "c:" + e; } } } return [...g()]; });
c("deep-try-nesting", function () { var depth = 0; function f(n) { try { if (n == 0) throw "bottom"; return f(n - 1); } finally { depth++; } } try { f(200); } catch (e) { return [e, depth]; } });
c("toString-reentry-in-catch", function () { var o = { toString: function () { try { throw 1; } catch (e) { return "S" + e; } } }; return "" + o + o; });
c("proxy-get-trap-throws-in-try", function () { var p = new Proxy({}, { get: function () { throw "trap"; } }); try { p.x; } catch (e) { return e; } });
c("setter-in-place-throw-caught-by-caller", function () { var o = { set v(x) { throw "set" + x; } }; function f() { try { o.v = 1; } catch (e) { return e; } } return f(); });
c("json-reviver-throw", function () { try { JSON.parse("[1]", function () { throw "rv"; }); } catch (e) { return e; } });
throw new Error(JSON.stringify(out));
