function m(f){ global.gc(); const a=process.memoryUsage().heapUsed; const k=f(); global.gc(); const b=process.memoryUsage().heapUsed; return ((b-a)/100000).toFixed(1)+' B/unit '+k.length; }
console.log('promise', m(()=>{const k=[];for(let i=0;i<100000;i++)k.push(new Promise(()=>{}));return k;}));
console.log('object', m(()=>{const k=[];for(let i=0;i<100000;i++)k.push({});return k;}));
