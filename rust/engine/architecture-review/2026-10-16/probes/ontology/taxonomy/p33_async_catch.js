// Can guest code observe a host stop raised inside an async function or promise reaction?
async function f() { try { "x".padEnd(2 ** 24 + 1, "x"); return "completed"; } catch (e) { return "caught " + e; } }
f().then(v => { throw new Error("async: " + v); }, e => { throw new Error("async rejected: " + e); });
