const keep = [];
for (let i = 0; i < 2000; i++) keep.push(new RegExp("a", "v"));
throw new Error(String(keep.length));
