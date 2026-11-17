// Two models of the global object: reflective (null proto) vs name resolution (Object.prototype).
const r = {};
function t(k, f) { try { r[k] = f(); } catch (e) { r[k] = 'threw ' + e.name + ': ' + e.message; } }
t('startProtoNull', () => Object.getPrototypeOf(globalThis) === null);
t('hasToString', () => Reflect.has(globalThis, 'toString'));
t('typeofToString', () => typeof toString);
t('thisHasOwn', () => this.hasOwnProperty('Array'));
t('cmpProtoNull', () => typeof Compartment === 'function' ? Object.getPrototypeOf(new Compartment().globalThis) === null : 'no Compartment');
t('cmpTypeofToString', () => typeof Compartment === 'function' ? new Compartment().evaluate('typeof toString') : 'no Compartment');
t('cmpHas', () => typeof Compartment === 'function' ? Reflect.has(new Compartment().globalThis, 'toString') : 'no Compartment');
// Inject a proto: property path sees it, identifier path does not.
Reflect.setPrototypeOf(globalThis, { __proto__: Object.prototype, injected: 42 });
t('viaProperty', () => globalThis.injected);
t('viaIdentifier', () => typeof injected);
throw new Error(JSON.stringify(r));
