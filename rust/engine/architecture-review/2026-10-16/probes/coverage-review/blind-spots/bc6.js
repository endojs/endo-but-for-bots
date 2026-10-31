var hits = 0;
var R;
try {
  var F = new Function('a', 'this.a = a');
  var B = F.bind(null, 3);
  hits = hits + 1;
  if (hits > 1) throw new Error('script prologue re-executed ' + hits + ' times');
  R = new B().a;
} catch (e) { R = 'caught ' + e; }
throw new Error(String(R));
