// After the array-index fill consumed the guest key space, does anything reach
// the permanent hard latch (Halt::Refused("property-key:id-space-exhausted"))?
try { new Array(70000).fill(0); } catch (e) {}
const out = [];
let n = 0;
try { for (let i = 0; i < 3000; i++) { const o = {}; o[Symbol("s" + i)] = i; n++; } out.push("symbol keys ok " + n); } catch (e) { out.push("symbol keys after " + n + ": " + e); }
let m = 0;
try { for (let i = 0; i < 3000; i++) { (0, eval)("var zzGlobal" + i + " = 1"); m++; } out.push("eval globals ok " + m); } catch (e) { out.push("eval globals after " + m + ": " + e); }
throw new Error(out.join(" | "));
