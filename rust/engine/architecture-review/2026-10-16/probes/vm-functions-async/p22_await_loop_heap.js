// 400,000 awaits of a non-promise value in one crank; nothing is retained.
let done = 0;
async function f() { for (let i = 0; i < 400000; i++) await 1; done = 1; }
f().then(function () { report('completed done=' + done); });
