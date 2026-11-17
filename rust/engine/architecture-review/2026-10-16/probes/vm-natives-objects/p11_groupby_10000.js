const xs = []; for (let i = 0; i < 10000; i++) xs.push(i);
const g = Map.groupBy(xs, x => x); if (g.size !== 10000) throw new Error('bad');
