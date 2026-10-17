var test262 = 'outer scope';
var probe1, probe2;
class C {
  static { var test262 = 'first block'; probe1 = test262; }
  static { var test262 = 'second block'; probe2 = test262; }
}
if (test262 !== 'outer scope' || probe1 !== 'first block' || probe2 !== 'second block') throw new Error(JSON.stringify([test262, probe1, probe2]));
