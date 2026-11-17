var __done=false;
(function(){ var p = Promise.resolve(); for (var i = 0; i < 200; i++) p = p.then(function(){}); p.then(function(){ if (!__done) { 'y'.repeat(2**28); } }); })();
