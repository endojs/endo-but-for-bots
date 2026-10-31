lockdown();
const c = new Compartment({});
const F = c.evaluate('Function'), E = c.evaluate('eval'), C = c.evaluate('Compartment');
const r = { F: Object.isFrozen(F), E: Object.isFrozen(E), C: Object.isFrozen(C),
  ext: Object.isExtensible(F), origFrozen: Object.isFrozen(Function), distinct: F !== Function,
  protoDesc: JSON.stringify(Object.getOwnPropertyDescriptor(F,'prototype'), (k,v)=>typeof v==='function'||typeof v==='object'&&k?'[o]':v),
  nameDesc: JSON.stringify(Object.getOwnPropertyDescriptor(F,'name')),
  ownKeys: Reflect.ownKeys(F).map(String) };
let leak; try { F.leak = 42; leak = c.evaluate('Function.leak'); } catch (e) { leak = 'threw ' + e.name; }
r.leak = leak;
let nm; try { F.name; Object.defineProperty(F,'name',{value:'x'}); nm = F.name; } catch(e) { nm='threw '+e.name; }
r.nameRedefined = nm;
throw new Error(JSON.stringify(r));
