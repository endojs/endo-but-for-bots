// Quantifier bound just above 2**31-1 (ECMA-262 allows any DecimalDigits MV).
let out = [];
for (const n of [2147483647, 2147483648]) {
  try { out.push(n + ":" + new RegExp("b{" + n + "}").test("")); }
  catch (e) { out.push(n + ":caught " + e.name); }
}
throw new Error(out.join(" "));
