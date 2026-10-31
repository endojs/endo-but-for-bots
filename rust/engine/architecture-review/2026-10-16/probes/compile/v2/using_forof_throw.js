var log = [];
function res(name, bad) { return { [Symbol.dispose]() { log.push("dispose:" + name); if (bad) throw new Error("E" + name); } }; }
var caught;
try { for (using x of [res("a", true), res("b")]) { log.push("body"); } log.push("after-loop"); } catch (e) { caught = e.message; }
var r1 = log.join() + " caught=" + caught;
log = [];
caught = undefined;
var it = { i: 0, next() { this.i++; return this.i <= 2 ? { value: res("i" + this.i), done: false } : { done: true }; }, return() { log.push("iter-return"); return {}; }, [Symbol.iterator]() { return this; } };
for (using y of it) { log.push("body"); }
var r2 = log.join();
throw new Error(["disposer-throws: " + r1, "custom-iter: " + r2].join(" ; "));
