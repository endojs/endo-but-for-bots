var __done=false; function $DONE(err){ if (err!==undefined) 'x'.repeat(2**28); __done=true; }
Promise.resolve().then(function(){ $DONE(new Error('fail')); });
