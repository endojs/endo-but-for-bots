(function(){'use strict';
var out=[]; var f=Object.freeze({k:1}); var k='k';
try{f[k]=2; out.push('computed:no-throw='+f.k)}catch(e){out.push('computed:'+e.constructor.name)}
try{f.k=2; out.push('static:no-throw')}catch(e){out.push('static:'+e.constructor.name)}
var h=harden ? 1:0;
throw new Error(out.join(' | '));
})();
