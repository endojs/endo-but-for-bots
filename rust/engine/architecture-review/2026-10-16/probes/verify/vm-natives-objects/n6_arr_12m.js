const a = [];
let i = 0;
try { for (; i < 12000000; i++) a.push(0); } catch (e) { throw new Error("arr stopped at " + i + " " + e.name); }
throw new Error("done arr 12M");
