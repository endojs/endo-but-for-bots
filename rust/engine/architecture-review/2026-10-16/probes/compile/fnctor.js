var out = [];
function t(label, f) { try { var r = f(); out.push(label + "=" + (typeof r === "function" ? "fn:" + r() : String(r))); } catch (e) { out.push(label + "=" + e.name); } }
t("params-inject", function () { return Function("a) { return 7 }; (function (", "return 1"); });
t("body-inject", function () { return Function("", "}); globalThis.pwned = 1; (function(){"); });
t("comment-param", function () { return Function("a //", "return 2"); });
t("html-close", function () { return Function("", "-->"); });
t("body-directive-nonsimple", function () { return Function("a = 1", "'use strict'; return a"); });
t("params-trailing-comma", function () { return Function("a,", "return 3"); });
t("async-fn", function () { return Object.getPrototypeOf(async function(){}).constructor("await 1; return 4")().constructor.name; });
t("gen-yield-param", function () { return Object.getPrototypeOf(function*(){}).constructor("yield", ""); });
out.push("pwned=" + (typeof globalThis.pwned));
throw new Error(out.join(" | "));
