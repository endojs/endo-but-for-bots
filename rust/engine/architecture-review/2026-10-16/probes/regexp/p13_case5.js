const r = /a/g; Object.setPrototypeOf(r, { get flags() { return "proto"; } }); throw new Error(String(r.flags));
