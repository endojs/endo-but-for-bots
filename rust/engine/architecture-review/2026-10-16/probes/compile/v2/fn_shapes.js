var out = [];
function t(label, f) { try { var r = f(); out.push(label + "=" + typeof r); } catch (e) { out.push(label + "=" + e.name); } }
t("comment-span", function () { return Function("/*", "*/){"); });
t("body-close-reopen", function () { return Function("}, function(){"); });
t("param-default-inject", function () { return Function("a = (globalThis.pd = 1)", ""); });
t("gen-body-yield-escape", function () { return Object.getPrototypeOf(function*(){}).constructor("}); (function*(){ yield 1"); });
out.push("pd=" + typeof globalThis.pd);
throw new Error(out.join(" | "));
