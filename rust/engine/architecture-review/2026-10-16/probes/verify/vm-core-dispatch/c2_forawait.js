var log = []; function L(x) { log.push(x); }
(async function () {
  try { for await (var x of [Promise.resolve("arr")]) L("A:" + (typeof x === "object" ? "promise" : x)); } catch (e) { L("A:throw " + e.message); }
  try { for await (var x of new Set([Promise.resolve("set")])) L("S:" + (typeof x === "object" ? "promise" : x)); } catch (e) { L("S:throw " + e.message); }
  try { var it = { [Symbol.iterator]() { var i = 0; return { next() { return i++ ? { done: true } : { value: Promise.resolve("custom"), done: false }; } }; } }; for await (var x of it) L("C:" + (typeof x === "object" ? "promise" : x)); } catch (e) { L("C:throw " + e.message); }
  try { function* g() { yield Promise.resolve("gen"); } for await (var x of g()) L("G:" + (typeof x === "object" ? "promise" : x)); } catch (e) { L("G:throw " + e.message); }
  try { for await (var x of [Promise.reject("rej")]) L("R:" + x); } catch (e) { L("R:caught " + (typeof e === "object" ? "obj" : e)); }
})();
