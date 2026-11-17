function u(s){ if (typeof s !== 'string') return typeof s + ':' + String(s); var r=[]; for (var i=0;i<s.length;i++){ var c=s.charCodeAt(i); r.push(c<0x80 && c>=0x20 && c!==0x2c ? String.fromCharCode(c) : 'U+'+c.toString(16)); } return r.join(''); }
var out = {};
function t(name, f){ try { out[name] = u(f()); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + u(String(e && e.message)); } }
t('stack_type', function(){ return typeof new Error('x').stack; });
t('stack_lone', function(){ var o = {['f\uD800']: function(){ return new Error('x').stack; }}; return o['f\uD800'](); });
t('stack_astral', function(){ var o = {['g\u{1d4b3}']: function(){ return new Error('x').stack; }}; return o['g\u{1d4b3}'](); });
t('stack_desc', function(){ var d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack'); return d ? (typeof d.get) + '/' + (typeof d.value) : 'none'; });
t('own_stack', function(){ var e = new Error('x'); return String(Object.prototype.hasOwnProperty.call(e, 'stack')); });
throw new Error(JSON.stringify(out));
