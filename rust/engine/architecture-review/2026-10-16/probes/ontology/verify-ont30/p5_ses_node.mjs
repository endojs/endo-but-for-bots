import '/home/user/endo-but-for-bots/packages/ses/index.js';
const r = {};
const c = new Compartment({});
r.childTypeofLockdown = c.evaluate('typeof lockdown');
r.startFrozenBefore = Object.isFrozen(Array.prototype);
try { c.evaluate('lockdown()'); r.childLockdown = 'ok'; } catch (e) { r.childLockdown = 'threw ' + e.name + ': ' + e.message; }
r.startFrozenAfter = Object.isFrozen(Array.prototype);
try { lockdown(); r.startLockdown = 'ok'; } catch (e) { r.startLockdown = 'threw ' + e.name + ': ' + e.message.slice(0,80); }
console.log(JSON.stringify(r));
