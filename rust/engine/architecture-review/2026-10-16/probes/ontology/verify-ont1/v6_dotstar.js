const line = "x".repeat(70000);
let r;
try { r = /.*/.exec(line)[0].length; } catch (e) { r = "caught " + e; }
throw new Error("dotstar:" + r);
