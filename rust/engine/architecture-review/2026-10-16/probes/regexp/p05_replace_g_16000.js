const n = 16000;
const s = "ab".repeat(n); const r = s.replace(/a/g, "x"); throw new Error(String(r.length));
