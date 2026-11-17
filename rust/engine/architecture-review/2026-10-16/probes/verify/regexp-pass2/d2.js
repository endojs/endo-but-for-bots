let n=0; for (const m of "ab".repeat(16000).matchAll(/a/g)) n++; throw new Error(String(n));
