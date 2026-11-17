var out = [];
var n = Object.create(null);
try { out.push('reflect: ' + Reflect.setPrototypeOf(Object.prototype, n)); } catch (e) { out.push('reflect threw ' + e.name); }
try { out.push('via proxy: ' + Reflect.setPrototypeOf(new Proxy(Object.prototype, {}), n)); } catch (e) { out.push('proxy threw ' + e.name); }
out.push('proto now null: ' + (Object.getPrototypeOf(Object.prototype) === null));
try { var d = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__'); out.push('setter: ' + (d.set.call(Object.prototype, n), 'ok')); } catch (e) { out.push('__proto__ setter threw ' + e.name); }
out.push('proto now null: ' + (Object.getPrototypeOf(Object.prototype) === null));
throw new Error(out.join(' | '));
