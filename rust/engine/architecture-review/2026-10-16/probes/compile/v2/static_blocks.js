var out = [];
function t(label, src) { try { out.push(label + "=" + String((0, eval)(src))); } catch (e) { out.push(label + "=" + e.name + ":" + e.message); } }
t("two-let", "class C { static { let a = 1; } static { let a = 2; } } 'ok'");
t("let-var-across", "class D { static { let b = 1; } static { var b = 2; } } 'ok'");
t("plain", "class E { static { E.x = 1; } } E.x");
throw new Error(out.join(" | "));
