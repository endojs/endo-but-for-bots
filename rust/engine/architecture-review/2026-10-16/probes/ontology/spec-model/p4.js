const r = {};
r.keys262 = Object.getOwnPropertyNames($262);
function t(name, f) { try { r[name] = f(); } catch (e) { r[name] = 'threw ' + e.name + ': ' + e.message; } }
t('es1', () => $262.evalScript('let gl1 = 1; var gv1 = 2;'));
t('gl1visible', () => typeof gl1);
t('gl1OnGlobal', () => Object.getOwnPropertyDescriptor(globalThis, 'gl1'));
t('dupLetVsVar', () => $262.evalScript('var gl1;'));
t('dupLetVsLet', () => $262.evalScript('let gl1;'));
t('letVsNonConfigGlobal', () => $262.evalScript('let NaN;'));
t('letVsUndefined', () => $262.evalScript('let undefined;'));
// atomicity of GlobalDeclarationInstantiation: second binding fails -> first must not be created
t('atomic', () => $262.evalScript('let fresh1; let gl1;'));
t('fresh1Created', () => { try { fresh1; return 'created'; } catch (e) { return e.name; } });
const c = new Compartment();
t('cmpLet', () => { c.evaluate('let cl = 5'); return c.evaluate('typeof cl'); });
t('cmpLetThenVar', () => c.evaluate('var cl'));
t('cmpLetThenLet', () => c.evaluate('let cl'));
t('cmpLetNaN', () => c.evaluate('let NaN'));
throw new Error(JSON.stringify(r));
