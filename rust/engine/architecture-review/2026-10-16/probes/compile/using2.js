var log = [];
for (using x of [{ [Symbol.dispose]() { log.push("d1"); } }, { [Symbol.dispose]() { log.push("d2"); } }]) { log.push("body"); }
log.push("after");
{ using y = { [Symbol.dispose]() { log.push("dy"); } }; log.push("blk"); }
function f() { using z = { [Symbol.dispose]() { log.push("dz"); } }; return 1; }
f();
for (const q of [1]) { using w = { [Symbol.dispose]() { log.push("dw"); } }; }
throw new Error(log.join());
