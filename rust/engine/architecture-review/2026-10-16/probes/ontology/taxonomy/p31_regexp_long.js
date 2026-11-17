// A greedy match over a long subject: does the matcher's scratch count as "heap"?
const out = [];
for (const n of [10000, 100000, 1000000]) {
  let r; try { r = /^\P{ASCII}+$/u.test("é".repeat(n)); } catch (e) { r = "caught " + e; }
  out.push(n + ":" + r);
}
throw new Error(out.join(" "));
