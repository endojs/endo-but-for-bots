var out = [];
out.push('frozen:' + Object.isFrozen(Object.prototype) + ',ext:' + Object.isExtensible(Object.prototype));
var n = Object.create(null);
out.push('reflect:' + Reflect.setPrototypeOf(Object.prototype, n));
out.push('proto is n:' + (Object.getPrototypeOf(Object.prototype) === n));
n.injected = 'from n';
out.push('({}).injected=' + ({}).injected);
try { Object.setPrototypeOf(Object.prototype, null); out.push('reset ok'); } catch (e) { out.push('reset threw ' + e.name); }
throw new Error(out.join(' | '));
