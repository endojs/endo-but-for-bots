var n = 0;
try { for (; n < 2000000; n++) { Function("var x" + (n % 10) + ";"); } } catch (e) { throw new Error("n=" + n + " " + e); }
