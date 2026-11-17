var log = [];
function res(name, bad) { return { [Symbol.dispose]() { log.push("dispose:" + name); if (bad) throw new Error("E" + name); } }; }
var out = [];
try { { using a = res("a", true); log.push("blk"); } out.push("no-throw"); } catch (e) { out.push("caught " + e.message); }
try { (function () { using b = res("b", true); return 1; })(); out.push("no-throw"); } catch (e) { out.push("caught " + e.message); }
try { for (let i = 0; i < 2; i++) { using c = res("c" + i, i === 0); } out.push("no-throw"); } catch (e) { out.push("caught " + e.message); }
try { for (using d = res("d", true); false;) {} out.push("no-throw"); } catch (e) { out.push("caught " + e.message); }
throw new Error(out.join(" | ") + " :: " + log.join());
