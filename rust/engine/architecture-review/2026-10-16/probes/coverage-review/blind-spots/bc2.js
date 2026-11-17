var out = [];
function t(name, f) { try { out.push([name, f()]); } catch (e) { out.push([name, 'THROW ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)]); } }
var F = new Function('a', 'this.a = a;');
var BF = F.bind(null, 'q');
t('new-Function-direct', () => new F('d').a);
t('new-Function-bound', () => new BF().a);
throw new Error(JSON.stringify(out));
