const xs = []; for (let i = 0; i < 40000; i++) xs.push(i);
const g = Map.groupBy(xs, x => x);
throw new Error(JSON.stringify([g.size]));
