var r = "ab".repeat(16000).match(/a/g); if (r.length !== 16000) throw new Error("count " + r.length);
