// does a finally run / does the outer frame observe anything?
let log = [];
try { try { new WeakMap([[Symbol("a"), 1]]); } finally { log.push("finally"); } } catch (e) { log.push("caught"); }
throw new Error(log.join(","));
