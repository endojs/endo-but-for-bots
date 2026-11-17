const keep = [];
for (let i = 0; i < 2000; i++) keep.push(new RegExp("\\p{RGI_Emoji}", "v"));
throw new Error(String(keep.length));
