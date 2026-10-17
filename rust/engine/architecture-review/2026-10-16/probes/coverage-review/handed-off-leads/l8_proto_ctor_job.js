// Pre-lockdown, bare ironhorse-xst host: a child reaches the shared %Function%
// through a prototype and runs it as a promise reaction. A direct call compiles
// against the child; the job runs in whatever environment the pump is in.
globalThis.marker = 'START';
globalThis.startSecret = 's3cret';
var seen = [];
var res = 'pending';
const c = new Compartment({ globals: { marker: 'CHILD', seen } });
c.evaluate(`
  const F = (function(){}).constructor;
  seen.push('direct:' + F('return marker')());
  Promise.resolve('return marker').then(F).then(f => { seen.push('job:' + f()); });
  Promise.resolve('return globalThis').then(F).then(f => { const g = f(); seen.push('jobGlobalHasStartSecret:' + (typeof g.startSecret)); });
  Promise.resolve('globalThis.wroteViaJob = 1').then(F).then(f => { f(); });
`);
Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => {
  res = seen.join('/') + ' startHasWrite=' + typeof globalThis.wroteViaJob + ' childHasWrite=' + c.evaluate('typeof globalThis.wroteViaJob');
});
