// Single case: 70000-char run under /a*/ inside try/catch.
let r;
try { r = /a*/.exec("a".repeat(70000))[0].length; } catch (e) { r = "caught " + e.name; }
throw new Error(JSON.stringify(r));
