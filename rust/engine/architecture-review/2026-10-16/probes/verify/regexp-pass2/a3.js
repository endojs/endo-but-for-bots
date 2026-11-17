const doc = "---\ntitle: x\n---\n" + "word ".repeat(20000); const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(doc); throw new Error(String(m[2].length));
