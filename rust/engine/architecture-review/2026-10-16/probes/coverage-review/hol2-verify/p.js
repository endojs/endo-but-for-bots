var __o=[]; var out = function(s){__o.push(s);};
function t(name, f) { try { out(name + ': ' + String(f())); } catch (e) { out(name + ': throw ' + e.name + ':' + e.message); } }
class B { constructor(){ this.b = 1; } }
t('super-call', () => { class C extends B { constructor(){ eval('super()'); } } return new C().b; });
t('super-call-arrow', () => { class C extends B { constructor(){ (()=>eval('super()'))(); this.x=2; } } return new C().x; });
t('super-twice', () => { class C extends B { constructor(){ super(); eval('super()'); } } return new C().b; });
t('super-method-neg', () => { class C extends B { m(){ return eval('super()'); } } return new C().m(); });
t('super-base-neg', () => { class C { constructor(){ eval('super()'); } } return new C(); });
t('nt-method', () => ({ m(){ return eval('typeof new.target'); } }).m());
t('nt-getter', () => ({ get g(){ return eval('typeof new.target'); } }).g);
t('nt-gen', () => { function* g(){ yield eval('typeof new.target'); } return g().next().value; });
t('nt-classmethod', () => { class C { m(){ return eval('typeof new.target'); } } return new C().m(); });
t('nt-arrow-in-method', () => ({ m(){ return (()=>eval('typeof new.target'))(); } }).m());
t('nt-async', () => { async function f(){ return eval('typeof new.target'); } f(); return 'see'; });
t('nt-fn', () => { function f(){ return eval('typeof new.target'); } return f(); });
t('nt-new', () => { var r; function F(){ r = eval('new.target') === F; } new F(); return r; });
t('nt-toplevel-neg', () => (0,eval)('new.target'));
throw new Error(JSON.stringify(__o, null, 0));
