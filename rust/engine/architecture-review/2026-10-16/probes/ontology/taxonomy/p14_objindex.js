// An ordinary object used as an integer-keyed map (common: memo tables, id maps).
const o = {};
let n = 0;
try { for (let i = 0; i < 100000; i++) { o[i] = i; n++; } } catch (e) { throw new Error("after " + n + " integer keys: " + e); }
// Spec: integer-like keys are ordinary property keys; nothing bounds them.
let r; try { const p = {}; p.someBrandNewName = 1; r = "new name ok"; } catch (e) { r = "new name " + e; }
throw new Error("all " + n + " ok; " + r);
