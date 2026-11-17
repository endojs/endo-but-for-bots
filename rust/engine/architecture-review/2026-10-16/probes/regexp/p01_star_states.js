// How long a run can a greedy star consume? Report the largest n that works.
const out = [];
for (const n of [1000, 30000, 65000, 65600, 70000, 200000]) {
  const s = "a".repeat(n);
  const m = /a*/.exec(s);
  out.push([n, m[0].length]);
}
throw new Error(JSON.stringify(out));
