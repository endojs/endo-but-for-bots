// Two fills of 40k distinct-index holey arrays: individually fine, together?
const out = [];
try { new Array(40000).fill(0); out.push("first ok"); } catch (e) { out.push("first " + e); }
try { const a = new Array(80000); a.fill(0, 40000); out.push("second ok"); } catch (e) { out.push("second " + e); }
let r; try { const o = {}; o.zz_fresh_name_1 = 1; r = "new-name ok"; } catch (e) { r = "new-name " + e; }
out.push(r);
throw new Error(out.join(" | "));
