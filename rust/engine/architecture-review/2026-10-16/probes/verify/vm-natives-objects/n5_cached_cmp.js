const s = 'x'.repeat(100000);
const a = []; for (let i = 0; i < 2000; i++) a.push(s);
a.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
throw new Error(JSON.stringify([a.length]));
