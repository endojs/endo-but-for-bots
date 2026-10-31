// PerformEval: inFunction is true for any non-arrow function, constructor or not.
var out = {};
try { out.method = ({ m() { return eval('typeof new.target'); } }).m(); } catch (e) { out.method = String(e); }
try { out.getter = Object.getOwnPropertyDescriptor({ get g() { return eval('typeof new.target'); } }, 'g').get(); } catch (e) { out.getter = String(e); }
try { out.generator = (function* () { yield eval('typeof new.target'); })().next().value; } catch (e) { out.generator = String(e); }
try { out.async = 'n/a'; } catch (e) {}
throw new Error(JSON.stringify(out));
