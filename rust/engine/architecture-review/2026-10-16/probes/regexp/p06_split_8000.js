const n = 8000;
const s = "a,".repeat(n); const r = s.split(/,/); throw new Error(String(r.length));
