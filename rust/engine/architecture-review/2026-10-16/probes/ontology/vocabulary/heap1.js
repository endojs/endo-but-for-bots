// How large a string can a guest build before HeapExhausted?
let n = 0;
let s = "";
try {
  for (n = 0; n < 24; n++) { s = s + s + "x"; }
} catch (e) { throw new Error("caught " + e.name + " at n=" + n + " len=" + s.length); }
throw new Error("done len=" + s.length);
