const ks = []; for (let i = 0; i < 2 * 5000; i++) ks.push({});
const w = new WeakMap(); for (const k of ks) w.set(k, 1);
for (const k of ks) w.delete(k);
throw new Error("done");
