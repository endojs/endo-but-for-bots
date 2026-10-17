// Increasing holey fills on one realm: where does the generic fill stop?
let last = 0, err = "none";
for (let n = 1000; n <= 80000; n += 1000) {
  try { new Array(n).fill(0); last = n; } catch (e) { err = String(e); break; }
}
throw new Error("last ok fill n=" + last + " | " + err);
