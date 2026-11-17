const xs = []; for (let i = 0; i < 40000; i++) xs.push(i);
const g = Map.groupBy(xs, x => x); if (g.size !== 40000) throw new Error('bad');
