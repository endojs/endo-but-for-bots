// search radix-16 / 10 strings where iterative acc*r+d (double) differs from exact rounding
const out = [];
function iter(s, r) { let a = 0; for (const c of s) a = a * r + parseInt(c, r); return a; }
function exact(s, r) { return Number(BigInt((r === 16 ? '0x' : '') + s)); }
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let i = 0; i < 200000 && out.length < 5; i++) {
  const r = rnd() < 0.5 ? 16 : 10; const len = r === 16 ? 15 + Math.floor(rnd() * 4) : 17 + Math.floor(rnd() * 4);
  let s = String(1 + Math.floor(rnd() * 9)); for (let j = 1; j < len; j++) s += Math.floor(rnd() * r).toString(r);
  if (iter(s, r) !== exact(s, r)) out.push([r, s, iter(s, r), exact(s, r)]);
}
console.log(JSON.stringify(out));
