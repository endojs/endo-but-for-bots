// Same "result too large" condition via repeat at 2**31 units: catchable here?
const out = [];
try { "x".repeat(2 ** 31); out.push("2^31 completed"); } catch (e) { out.push("2^31 caught " + e); }
throw new Error(out.join(" | "));
