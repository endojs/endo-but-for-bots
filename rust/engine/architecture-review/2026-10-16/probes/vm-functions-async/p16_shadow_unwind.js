let x = 1;
{ let x = 2; }
const out = [];
out.push(x);
{ let x = 3; { let x = 4; } out.push(x); }
out.push(typeof x, x);
throw new Error(JSON.stringify(out));
