const n = 8000;
const s = "ab".repeat(n); const r = s.match(/a/g); throw new Error(String(r.length));
