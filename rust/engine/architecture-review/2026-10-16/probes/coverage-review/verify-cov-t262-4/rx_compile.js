var out=[];
var r=/a/g; r.lastIndex=3;
var ret=r.compile('b','i');
out.push('same:'+(ret===r)); out.push('src:'+r.source); out.push('flags:'+r.flags); out.push('li:'+r.lastIndex); out.push('test-b:'+r.test('B'));
try{RegExp.prototype.compile.call({},'a');out.push('obj:no-throw')}catch(e){out.push('obj:'+e.constructor.name)}
try{/a/.compile('(');out.push('invalid:no-throw')}catch(e){out.push('invalid:'+e.constructor.name)}
try{var q=/a/;Object.defineProperty(q,'lastIndex',{writable:false});q.compile('b');out.push('immut-li:no-throw')}catch(e){out.push('immut-li:'+e.constructor.name)}
var s=/x/; s.compile(/y/m); out.push('re-arg:'+s.source+'/'+s.flags);
throw new Error(JSON.stringify(out));
