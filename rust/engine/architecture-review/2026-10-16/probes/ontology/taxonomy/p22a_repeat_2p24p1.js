const n = 2 ** 24 + 1;
let r; try { r = "repeat:" + "x".repeat(n).length + " concat:" + ("x".repeat(n - 1) + "x").length + " join:" + Array(n + 1).join("x").length; } catch (e) { r = "caught " + e; }
throw new Error(r);
