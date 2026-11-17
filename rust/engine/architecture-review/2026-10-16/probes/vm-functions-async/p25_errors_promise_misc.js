const out = [];
function t(name, f) { try { out.push(name + '=' + f()); } catch (e) { out.push(name + '!' + (e && e.constructor && e.constructor.name) + ':' + (e && e.message)); } }
t('cause', function () { const e = new Error('m', { cause: 0 }); return Object.prototype.hasOwnProperty.call(e, 'cause') + '/' + e.cause; });
t('no-cause', function () { return 'cause' in new Error('m', {}); });
t('toString-generic', function () { return Error.prototype.toString.call({ name: 'N', message: 'M' }); });
t('toString-empty', function () { return Error.prototype.toString.call({ name: '', message: 'M' }) + '|' + Error.prototype.toString.call({}); });
t('agg', function () { const a = new AggregateError(new Set([1, 2]), 'msg', { cause: 'c' }); return a.errors.join() + '/' + a.message + '/' + a.cause + '/' + Array.isArray(a.errors); });
t('captureStackTrace', function () { return typeof Error.captureStackTrace; });
t('stack-own', function () { const e = new Error('x'); return typeof e.stack + '/' + Object.prototype.hasOwnProperty.call(e, 'stack'); });
t('isError', function () { return typeof Error.isError === 'function' ? Error.isError(new TypeError()) + '' + Error.isError({}) : 'absent'; });
t('message-own', function () { return Object.getOwnPropertyNames(new Error('a')).sort().join(); });
t('withResolvers', function () { const r = Promise.withResolvers(); return Object.keys(r).join() + '/' + (r.promise instanceof Promise); });
t('try-sync-throw', function () { let st; Promise.try(function () { throw 1; }).catch(function (e) { st = e; }); return typeof Promise.try; });
t('try-args', function () { let got; Promise.try(function (a, b) { got = a + b; }, 2, 3); return got; });
t('then-non-callable', function () { return Promise.resolve(1).then(5) instanceof Promise; });
t('resolve-self', function () { let res; const p = new Promise(function (r) { res = r; }); res(p); return 'ok'; });
throw new Error(JSON.stringify(out));
