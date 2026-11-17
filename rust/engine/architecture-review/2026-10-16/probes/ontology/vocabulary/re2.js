// A greedy quantifier over a 100k-char subject: catchable? configured heap ceiling?
const s = "a".repeat(100000);
let r;
try { r = /^a+$/.test(s); } catch (e) { throw new Error("caught " + e.name); }
throw new Error("ok " + r);
