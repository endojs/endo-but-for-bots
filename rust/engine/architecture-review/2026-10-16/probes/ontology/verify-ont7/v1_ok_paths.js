const n = 2 ** 24 + 1;
const out = {};
out.repeat = "x".repeat(n).length;
out.concat = ("x".repeat(n - 1) + "x").length;
out.denseJoin = Array.from({ length: 17 }, () => "a".repeat(1000000)).join("").length;
throw new Error(JSON.stringify(out));
