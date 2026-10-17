// A realistic shape: trim trailing whitespace of a 100k-char line.
const line = "x".repeat(100000) + "   ";
let r;
try { r = line.replace(/\s+$/, "").length; } catch (e) { r = "caught " + e.name; }
let r2;
try { r2 = /^(.*)$/.exec(line)[1].length; } catch (e) { r2 = "caught " + e.name; }
throw new Error(JSON.stringify([r, r2]));
