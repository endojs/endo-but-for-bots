var out=[];
var S=''[Symbol.iterator](), A=[].values();
var SP=Object.getPrototypeOf(S), AP=Object.getPrototypeOf(A);
out.push("same-proto:"+(SP===AP));
var s2='ab'[Symbol.iterator](), a2=[1,2].values();
try{out.push("A.next on str:"+JSON.stringify(AP.next.call(s2)))}catch(e){out.push("A.next on str:"+e.constructor.name)}
try{out.push("S.next on arr:"+JSON.stringify(SP.next.call(a2)))}catch(e){out.push("S.next on arr:"+e.constructor.name)}
out.push(Object.prototype.toString.call(S));
out.push(Object.prototype.toString.call(A));
out.push(Reflect.ownKeys(AP).map(String).join('|'));
out.push(Reflect.ownKeys(SP).map(String).join('|'));
var r=JSON.stringify(out);
throw new Error(r);
