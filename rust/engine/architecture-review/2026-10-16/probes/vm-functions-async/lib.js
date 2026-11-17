function report(msg) {
  if (typeof process !== 'undefined') { console.log('Error: ' + msg); return; }
  // ironhorse: escape a promise job, since the custom capability's resolve
  // throws and the drain propagates that throw to the host.
  const p = Promise.resolve();
  const C = function (executor) { executor(function () { throw new Error(msg); }, function () {}); };
  C[Symbol.species] = C;
  p.constructor = C;
  p.then(function () {});
}
function after(n, f) { let p = Promise.resolve(); for (let i = 0; i < n; i++) p = p.then(function () {}); p.then(f); }
