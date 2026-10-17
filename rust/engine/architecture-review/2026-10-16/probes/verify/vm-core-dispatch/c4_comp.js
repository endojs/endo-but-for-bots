var out=[];
try { var c = new Compartment(); out.push("comp-proto-null=" + c.evaluate("Object.getPrototypeOf(globalThis) === null")); } catch (e) { out.push("comp-throw " + e.message); }
throw new Error(JSON.stringify(out));
