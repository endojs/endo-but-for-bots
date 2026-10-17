// Pre-lockdown (bare xst): child reaches shared %Function% via prototype, runs it as a promise reaction.
globalThis.marker = 'START';
var seen = [];
const c = new Compartment({ globals: { marker: 'CHILD', seen } });
c.evaluate(`
  const F = (function(){}).constructor;
  seen.push(F('return marker')());
  Promise.resolve('return marker').then(F).then(f => { seen.push(f()); });
  Promise.resolve('globalThis.wroteViaJob = 1').then(F).then(f => { f(); });
`);
Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => {
  throw new Error(seen.join('/') + ' startHasWrite=' + typeof globalThis.wroteViaJob + ' childHasWrite=' + c.evaluate('typeof globalThis.wroteViaJob'));
});
