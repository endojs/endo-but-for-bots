const out=[];
const d=Object.getOwnPropertyDescriptor(Error.prototype,'stack');
out.push(typeof d, d&&typeof d.get, d&&typeof d.set, d&&d.configurable, d&&d.enumerable);
const e=new Error('x');
try{ e.stack=5; out.push('set-nonstring:no-throw:'+e.stack+':'+JSON.stringify(Object.getOwnPropertyDescriptor(e,'stack')));}catch(x){out.push('set-nonstring:'+x.name);}
try{ Error.prototype.stack='s'; out.push('set-proto:no-throw:'+Object.getOwnPropertyNames(Error.prototype).includes('stack')+':'+typeof Object.getOwnPropertyDescriptor(Error.prototype,'stack').get);}catch(x){out.push('set-proto:'+x.name);}
// non-error receiver
try{ const o={}; d.set.call(o,'z'); out.push('set-nonerror:no-throw:'+o.stack);}catch(x){out.push('set-nonerror:'+x.name);}
try{ out.push('get-nonerror:'+String(d.get.call({})));}catch(x){out.push('get-nonerror:'+x.name);}
try{ out.push('get-proto:'+String(d.get.call(Error.prototype)));}catch(x){out.push('get-proto:'+x.name);}
// existing non-configurable own property
const f=new Error('y'); Object.defineProperty(f,'stack',{value:1,writable:true,configurable:false});
try{ d.set.call(f,'q'); out.push('set-existing-nc:'+f.stack);}catch(x){out.push('set-existing-nc:'+x.name+':'+x.message);}
// proxy
const log=[]; const p=new Proxy(new Error('w'),{defineProperty(t,k,v){log.push('dp:'+String(k));return false;},getOwnPropertyDescriptor(t,k){log.push('gopd:'+String(k));return Reflect.getOwnPropertyDescriptor(t,k);}});
try{ d.set.call(p,'s'); out.push('set-proxy-reject:no-throw:'+log.join(','));}catch(x){out.push('set-proxy-reject:'+x.name+':'+log.join(','));}
console.log(JSON.stringify(out));
