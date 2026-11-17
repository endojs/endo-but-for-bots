const out = [];
let a;
try { a = new Array(2**24); out.push("new ok"); } catch (e) { out.push("new " + e); }
try { a.fill("abc"); out.push("fill ok"); } catch (e) { out.push("fill " + e); }
try { const s = a.join(""); out.push("join ok " + s.length); } catch (e) { out.push("join " + e); }
throw new Error(out.join(" | "));
