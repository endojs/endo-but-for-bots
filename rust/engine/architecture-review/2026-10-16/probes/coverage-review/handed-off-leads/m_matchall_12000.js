var c = 0; for (var m of "ab".repeat(12000).matchAll(/a/g)) c++; if (c !== 12000) throw new Error("count " + c);
