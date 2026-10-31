// allocate and drop 10M small objects; only one is live at a time
var last;
var i = 0;
try {
  for (i = 0; i < 10000000; i++) { last = { a: i }; }
} finally {
  // unreachable on halt
}
throw new Error("completed " + i);
