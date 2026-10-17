const r = {};
function t(n, f) { try { f(); r[n] = 'ok'; } catch (e) { r[n] = e.name + ': ' + e.message; } }
t('wm_set', () => new WeakMap().set(Symbol('a'), 1));
t('ws_add', () => new WeakSet().add(Symbol('a')));
t('wr', () => new WeakRef(Symbol('a')));
t('fr_reg', () => new FinalizationRegistry(() => {}).register(Symbol('a'), 1));
t('wm_registered', () => new WeakMap().set(Symbol.for('a'), 1));
throw new Error(JSON.stringify(r));
