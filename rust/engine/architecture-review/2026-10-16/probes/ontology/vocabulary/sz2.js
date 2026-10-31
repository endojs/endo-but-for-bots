// One condition ("result string longer than the engine admits"), several
// ceilings and halt classes depending on which built-in builds the string.
const n = 17000000; // 2^24 = 16777216 < n; 34 MB of UTF-16, far below the 256 MiB chunk ceiling
const out = {};
out.repeat = "a".repeat(n).length;
out.concatLoop = (() => { let s = "a".repeat(n - 1); return (s + "b").length; })();
out.denseJoin = Array.from({ length: 17 }, () => "a".repeat(1000000)).join("").length;
throw new Error(JSON.stringify(out));
