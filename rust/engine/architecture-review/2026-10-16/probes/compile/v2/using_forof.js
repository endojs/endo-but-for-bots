var log = [];
function res(name) { return { [Symbol.dispose]() { log.push("dispose:" + name); } }; }
for (using x of [res("a"), res("b"), res("c")]) { log.push("body"); }
log.push("after-loop");
var log2 = [];
var n = 0;
for (using y of [res("p")]) { log2.push("b"); }
var r1 = log.join();
log = [];
for (using z of [res("q"), res("r")]) { if (true) break; }
var r2 = log.join();
log = [];
try { for (using w of [res("s"), res("t")]) { throw 1; } } catch (e) {}
var r3 = log.join();
log = [];
function f() { for (using v of [res("u"), res("v")]) { return 1; } }
f();
var r4 = log.join();
throw new Error(["plain=" + r1, "break=" + r2, "throw=" + r3, "return=" + r4].join(" ; "));
