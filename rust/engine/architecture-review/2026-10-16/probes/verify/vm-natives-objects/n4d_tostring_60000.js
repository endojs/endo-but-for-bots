const fs = []; for (let i = 0; i < 60000; i++) fs.push(() => i);
const o = { join: 1 };
for (let i = 0; i < 20000; i++) Array.prototype.toString.call(o);
throw new Error("done");
