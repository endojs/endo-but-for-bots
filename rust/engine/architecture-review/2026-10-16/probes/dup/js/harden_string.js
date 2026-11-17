var out = [];
function probe(label, f) {
  try { out.push(label + ':' + f()); } catch (e) { out.push(label + ' threw ' + e.name + ': ' + e.message); }
}
probe('typeof harden', function () { return typeof harden; });
probe('typeof petrify', function () { return typeof petrify; });
probe('harden String wrapper', function () {
  var s = new String('abc');
  harden(s);
  return [Object.isFrozen(s), Object.getOwnPropertyNames(s).join(',')].join('|');
});
probe('freeze String wrapper', function () {
  var s = new String('abc');
  Object.freeze(s);
  return [Object.isFrozen(s), Object.getOwnPropertyNames(s).join(',')].join('|');
});
probe('petrify String wrapper', function () {
  var s = new String('abc');
  petrify(s);
  return [Object.isFrozen(s), Object.getOwnPropertyNames(s).join(',')].join('|');
});
throw new Error(JSON.stringify(out));
