// return() on an async generator suspended at a yield, with and without finally,
// against an explicit `return` in the body (FN-7's scenario) and a completed generator.
var log = []; function L(x) { log.push(x); }
async function* g1() { yield 1; }
async function* g2() { try { yield 1; } finally { L("g2-fin"); } }
async function* g3() { return 7; }
async function* g4() {}
var i1 = g1(), i2 = g2(), i4 = g4();
i1.next(); i2.next(); i4.next();
Promise.resolve().then(function () {
  L("t0");
  i1.return(42).then(function (r) { L("i1-ret " + r.value); });
  i2.return(43).then(function (r) { L("i2-ret " + r.value); });
  g3().next().then(function (r) { L("g3-next " + r.value); });
  i4.return(44).then(function (r) { L("i4-ret(completed) " + r.value); });
  Promise.resolve().then(function () { L("p1"); }).then(function () { L("p2"); }).then(function () { L("p3"); }).then(function () { L("p4"); }).then(function () { L("p5"); });
});
