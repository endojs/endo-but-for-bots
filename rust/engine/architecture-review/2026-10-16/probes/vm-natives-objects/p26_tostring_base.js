const fs = []; for (let i = 0; i < 60000; i++) fs.push(function () { return i; });
const o = { join: 1 };
for (let i = 0; i < 20000; i++) Object.prototype.toString.call(o);
