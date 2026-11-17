const r = {};
function t(name, f) { try { r[name] = f(); } catch (e) { r[name] = 'threw ' + e.name + ': ' + e.message; } }
const ia = new Int32Array(new SharedArrayBuffer(8));
t('waitNotEqual', () => Atomics.wait(ia, 0, 1, 0));
t('waitTimeout0', () => Atomics.wait(ia, 0, 0, 0));
t('waitTimeout10', () => Atomics.wait(ia, 0, 0, 10));
t('waitAsync', () => typeof Atomics.waitAsync);
t('waitAsyncResult', () => { const x = Atomics.waitAsync(ia, 0, 0, 10); return { async: x.async, valueType: typeof x.value }; });
t('notify', () => Atomics.notify(ia, 0, 1));
t('nonShared', () => Atomics.wait(new Int32Array(4), 0, 0, 0));
throw new Error(JSON.stringify(r));
