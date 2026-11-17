var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name + ': ' + e.message; } }
t('apply_on_nonfn', function () { try { var r = new Proxy({}, { apply: function () { return 1; } })(); return 'called:' + r; } catch (e) { return e.name; } });
t('typeof_nonfn_proxy', function () { return typeof new Proxy({}, { apply: function () { return 1; } }); });
t('construct_on_nonctor', function () { try { new (new Proxy(function(){}.bind(), {}))(); return 'ok'; } catch (e) { return e.name; } });
t('isfrozen_pe_arr', function () { return Object.isFrozen(Object.preventExtensions([])); });
t('isfrozen_pe_arr_len', function () { return JSON.stringify(Object.getOwnPropertyDescriptor(Object.preventExtensions([]), 'length')); });
t('global_proto', function () { var p = Object.getPrototypeOf(globalThis); return p === null ? 'null' : (p === Object.prototype ? 'Object.prototype' : typeof p); });
throw new Error(JSON.stringify(R));
