var r=[];function st(l,f){try{f();r.push(l+':ok')}catch(e){r.push(l+':'+e.message)}}
st('names40k',function(){var o={};for(var i=0;i<40000;i++)o['q'+i]=1});
st('sort30k',function(){new Array(30000).fill(1).sort()});
throw new Error(r.join(' | '));
