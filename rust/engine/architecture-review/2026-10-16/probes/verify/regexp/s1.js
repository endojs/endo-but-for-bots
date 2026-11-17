const tpls = ["[$$]", "[$&]", "[$`]", "[$']", "[$1]", "[$01]", "[$10]", "[$2]", "[$00]", "[$<n>]", "[$<zz>]", "[$<n]", "[$", "[$x]", "[$11]"];
const out = [];
for (const t of tpls) {
  const fast = "xabcy".replace(/(?<n>b)/, t);
  const r = /(?<n>b)/; const ex = RegExp.prototype.exec; r.exec = function (s) { return ex.call(this, s); };
  const gen = "xabcy".replace(r, t);
  const plain = "xabcy".replace("b", t);
  out.push([t, fast, gen, plain].join("|"));
}
throw new Error(out.join(" ;; "));
