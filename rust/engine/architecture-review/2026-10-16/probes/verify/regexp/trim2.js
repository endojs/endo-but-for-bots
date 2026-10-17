const s=" x".repeat(40000); throw new Error(String(s.replace(/\s+$/,"").length + "/" + /^(.*)$/.exec(s)[1].length));
