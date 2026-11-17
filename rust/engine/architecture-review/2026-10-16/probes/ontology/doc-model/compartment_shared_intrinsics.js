// ironhorse-vm/src/lib.rs:13-14 says "Each Compartment retains a Realm with independent globals";
// realm.rs:23 says there is one Realm whose intrinsics every compartment shares.
const out = {};
const a = new Compartment({ globals: {} });
const b = new Compartment({ globals: {} });
out.sameArrayProto = a.evaluate('Array.prototype') === b.evaluate('Array.prototype');
out.frozen = Object.isFrozen(Array.prototype);
try { a.evaluate('Array.prototype.leak = "from-a"'); } catch (e) { out.writeErr = String(e); }
out.seenInB = b.evaluate('typeof [].leak === "string" ? [].leak : "none"');
out.seenInStart = [].leak === undefined ? 'none' : [].leak;
a.evaluate('var answer = 42');
out.globalInB = b.evaluate('typeof answer');
throw new Error(JSON.stringify(out));
