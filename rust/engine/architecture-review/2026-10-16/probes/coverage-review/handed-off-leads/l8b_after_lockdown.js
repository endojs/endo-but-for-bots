globalThis.marker = 'START';
globalThis.startSecret = 's3cret';
var seen = [];
var res = 'pending';
lockdown();
const c = new Compartment({ globals: { marker: 'CHILD', seen } });
c.evaluate(`
  let F; try { F = (function(){}).constructor; F('1'); } catch (e) { seen.push('protoCtor:' + e.name); F = null; }
  if (F) Promise.resolve('return globalThis').then(F).then(f => { const g = f(); seen.push('jobGlobalHasStartSecret:' + (typeof g.startSecret)); });
`);
Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => { res = seen.join('/'); });
