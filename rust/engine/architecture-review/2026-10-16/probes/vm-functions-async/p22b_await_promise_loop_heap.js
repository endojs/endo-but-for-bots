// 400,000 awaits of an already-resolved native promise (fast path).
const p = Promise.resolve(1);
async function f() { for (let i = 0; i < 400000; i++) await p; }
f().then(function () { report('completed'); });
