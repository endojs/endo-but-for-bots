var n = 0;
for (; n < 100000; n++) { Function("var x" + (n % 10) + ";"); }
throw new Error("done " + n);
