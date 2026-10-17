// Is either stop catchable by the guest? (Neither should be: both abort to host.)
let r = [];
try { (function nest() { nest(); })(); } catch (e) { r.push("plain:" + e.name); }
throw new Error(JSON.stringify(r));
