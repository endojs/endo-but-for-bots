let calls = 0;
const a = []; for (let i = 0; i < 8; i++) a.push({ v: 8 - i, toString() { calls++; return String(this.v); } });
a.sort();
throw new Error(JSON.stringify([calls, a.map(x => x.v).join()]));
