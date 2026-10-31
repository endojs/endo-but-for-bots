const ks = []; for (let i = 0; i < 200000; i++) ks.push({});
const w = new WeakMap(); for (const k of ks) w.set(k, 1);
throw new Error("done");
