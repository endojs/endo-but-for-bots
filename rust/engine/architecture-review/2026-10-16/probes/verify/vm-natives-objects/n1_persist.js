const out = [];
new Array(40000).fill(0); out.push("40k fill ok");
const o = {}; let i = 0;
try { for (; i < 30000; i++) o["zz" + i] = i; out.push("30k names ok"); } catch (e) { out.push("names failed after " + i + " " + e.name); }
throw new Error(JSON.stringify(out));
