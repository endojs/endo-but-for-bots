const o = {};
let n = 0;
try { for (let i = 0; i < 100000; i++) { o[i] = i; n++; } } catch (e) {}
let r; try { globalThis.freshName = 1; ({}).anotherFreshName = 2; r = "fresh names ok"; } catch (e) { r = "fresh names: " + e; }
throw new Error("filled " + n + "; " + r);
