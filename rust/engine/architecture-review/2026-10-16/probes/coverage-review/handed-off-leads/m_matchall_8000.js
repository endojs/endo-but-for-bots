var c = 0; for (var m of "ab".repeat(8000).matchAll(/a/g)) c++; if (c !== 8000) throw new Error("count " + c);
