const mk = (globals) => new Compartment({ globals });
// The start compartment keeps an allowlist in a start global and gives a
// child compartment a checker that consults it, as SES code routinely does.
globalThis.allowlist = ['alice'];
const isAllowed = (user) => allowlist.includes(user);
const record = (entry) => { globalThis.lastEntry = entry; };
lockdown();
const c = mk({ isAllowed, record });
const r = {};
const t = (f) => { try { return f(); } catch (e) { return 'threw ' + e.name + ': ' + e.message; } };
r.childPlain = t(() => c.evaluate("isAllowed('mallory')"));
r.childShadow = t(() => c.evaluate("globalThis.allowlist = ['mallory']; isAllowed('mallory')"));
r.startView = isAllowed('mallory');
t(() => c.evaluate("record('from-child')"));
r.startLastEntry = typeof globalThis.lastEntry === 'undefined' ? 'undefined' : globalThis.lastEntry;
r.childLastEntry = t(() => c.evaluate("typeof lastEntry === 'undefined' ? 'undefined' : lastEntry"));
// A function created after the first Compartment, for contrast.
const isAllowedAfter = (user) => allowlist.includes(user);
const c2 = mk({ isAllowedAfter });
r.childShadowAfterFlipFn = t(() => c2.evaluate("globalThis.allowlist = ['mallory']; isAllowedAfter('mallory')"));
throw new Error(JSON.stringify(r));
