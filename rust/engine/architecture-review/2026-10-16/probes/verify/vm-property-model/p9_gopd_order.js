var log = [];
var target = new Proxy({}, { isExtensible: function (t) { log.push('isExtensible'); return Reflect.isExtensible(t); } });
var desc = {};
['enumerable','configurable','value','writable','get','set'].forEach(function (k) {
  Object.defineProperty(desc, k, { get: function () { log.push('get ' + k); return k === 'configurable' ? true : (k === 'get' || k === 'set' ? undefined : 1); }, enumerable: true });
});
var p = new Proxy(target, { getOwnPropertyDescriptor: function () { return { get enumerable() { log.push('get enumerable'); return true; }, get configurable() { log.push('get configurable'); return true; }, get value() { log.push('get value'); return 1; }, get writable() { log.push('get writable'); return true; } }; } });
try { Object.getOwnPropertyDescriptor(p, 'x'); } catch (e) { log.push('threw ' + e.name); }
throw new Error(log.join(','));
