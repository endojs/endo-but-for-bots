var out = [];
{ function q() {} }
out.push(typeof q);
function f() { { function r() {} } return typeof r; }
out.push(f());
try { out.push(String((0, eval)("{ function s(){} } typeof s"))); } catch (e) { out.push(e.name); }
throw new Error(out.join(","));
