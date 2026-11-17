var out = [];
function t(src) { try { out.push(String((0, eval)(src))); } catch (e) { out.push(e.name + ":" + e.message); } }
t("if (true) function g2(){ return 1; } typeof g2");
t("l: function h2(){} typeof h2");
t("var x2 = 1; <!-- c\n x2");
t("var x3 = 2;\n--> c\n x3");
t("(function(){ return this === undefined ? 'strict' : 'sloppy'; })()");
throw new Error(out.join(" | "));
