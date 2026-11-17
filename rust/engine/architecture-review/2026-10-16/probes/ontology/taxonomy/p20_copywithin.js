const out = [];
try { const a = new Array(140000); a[0] = 1; a.copyWithin(70000, 0); out.push("copyWithin ok"); } catch (e) { out.push("copyWithin " + e); }
throw new Error(out.join(" | "));
