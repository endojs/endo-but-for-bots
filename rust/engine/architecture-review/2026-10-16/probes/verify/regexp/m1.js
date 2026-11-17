const s = "b".repeat(1 << 22); const r = /a/y; let c = 0;
for (let i = 0; i < 200; i++) { r.lastIndex = 0; if (r.test(s)) c++; }
throw new Error(String(c));
