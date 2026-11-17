// Can a child compartment built on an UNFROZEN machine reach and run lockdown(),
// freezing the start compartment's realm? (realm.rs:311-313 says an unfrozen
// machine "does not bind `lockdown` at all".)
const r = {};
const c = new Compartment({});
r.childTypeofLockdown = c.evaluate('typeof lockdown');
r.startFrozenBefore = Object.isFrozen(Array.prototype);
try { c.evaluate('lockdown()'); r.childLockdown = 'ok'; } catch (e) { r.childLockdown = 'threw ' + e.name + ': ' + e.message; }
r.startFrozenAfter = Object.isFrozen(Array.prototype);
try { lockdown(); r.startLockdown = 'ok'; } catch (e) { r.startLockdown = 'threw ' + e.name + ': ' + e.message; }
throw new Error(JSON.stringify(r));
