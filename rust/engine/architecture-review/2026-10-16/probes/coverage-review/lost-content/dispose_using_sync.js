var out = [];
Number.prototype[Symbol.dispose] = function () { out.push("num-dispose"); };
try { { using x = 5; out.push("using5:ok"); } } catch (e) { out.push("using5:" + e.name); }
throw new Error(out.join(" | "));
