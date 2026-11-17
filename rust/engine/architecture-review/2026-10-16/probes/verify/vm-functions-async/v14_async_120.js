async function r(n){ if (n>0) await r(n-1); } var ok="pending"; try { r(120).then(function(){ok="ok"}); } catch(e) { ok="caught "+e; } Promise.resolve().then(function(){}).then(function(){}); 
