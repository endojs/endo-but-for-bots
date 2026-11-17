const out = [];
function t(name, f) { try { out.push([name, f()]); } catch (e) { out.push([name, 'THROW ' + (e && e.constructor && e.constructor.name) + ': ' + (e && e.message)]); } }
t('apply-huge-len', () => Reflect.apply(function(){return arguments.length}, null, {length: 2**32 + 5}));
t('apply-1e7-len', () => Reflect.apply(function(){return arguments.length}, null, {length: 1e7}));
t('construct-huge-len', () => Reflect.construct(function(){ this.n = arguments.length; }, {length: 2**53 - 1}).n);
throw new Error(JSON.stringify(out));
