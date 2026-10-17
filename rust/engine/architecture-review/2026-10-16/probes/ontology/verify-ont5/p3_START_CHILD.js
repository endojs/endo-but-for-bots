// A child registers the SHARED Function constructor (reached through the prototype,
// pre-lockdown) as a promise reaction handler. Which global does the job compile against?
// Output channel: a job cannot throw to the host, so the job halts the engine with an
// uncatchable resource stop when the value is START, and completes when it is CHILD.
globalThis.marker = 'START';
function report(v) {
  if (v.startsWith('START/CHILD')) { const a = []; for (;;) a.push(new Array(1e6)); }
}
const c = new Compartment({ globals: { marker: 'CHILD', report } });
c.evaluate(`
  const F = (function(){}).constructor;
  const direct = F('return globalThis.marker')();
  Promise.resolve('return globalThis.marker').then(F).then(f => report(direct + '/' + f()));
`);
