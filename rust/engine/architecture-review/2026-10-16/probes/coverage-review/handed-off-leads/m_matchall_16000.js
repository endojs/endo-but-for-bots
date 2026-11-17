var c = 0; for (var m of "ab".repeat(16000).matchAll(/a/g)) c++; if (c !== 16000) throw new Error("count " + c);
