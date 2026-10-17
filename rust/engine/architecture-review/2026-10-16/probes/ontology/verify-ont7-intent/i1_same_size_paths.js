const n = 2 ** 24 + 1;
const out = {};
out.repeat = "x".repeat(n).length;
out.concat = ("x".repeat(n - 1) + "x").length;
throw new Error(JSON.stringify(out));
