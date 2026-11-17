const n = 16000;
const s = "ab".repeat(n); let c = 0; for (const m of s.matchAll(/a/g)) c++; throw new Error(String(c));
