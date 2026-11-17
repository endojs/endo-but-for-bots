const ks = []; for (let i = 0; i < 200000; i++) ks.push({});
const w = new WeakMap(); for (const k of ks) w.set(k, 1);
for (let i = 0; i < 200; i++) w.delete(ks[i]);
throw new Error("done");
