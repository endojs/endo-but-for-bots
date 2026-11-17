// After lockdown: the start compartment's own `eval` is endowed to a child. The child calls it
// directly and also registers it as a promise reaction handler. ECMA-262 (PerformEval: evalRealm is the
// eval function's realm) and XS (fx_eval: home module -> mxProgram) give START both times.
// Output channel: jobs cannot throw to the host, so report() halts with HeapExhausted iff it sees
// the pair named on the command line's sed variant below.
globalThis.marker = 'START';
lockdown();
function report(v) {
  if (v === 'START/START') { const a = []; for (;;) a.push(new Array(1e6)); }
}
const c = new Compartment({ globals: { marker: 'CHILD', startEval: eval, report } });
c.evaluate(`
  const direct = startEval('marker');
  Promise.resolve('marker').then(startEval).then(v => report(direct + '/' + v));
`);
