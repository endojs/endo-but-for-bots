var __done=false; globalThis.$DONE=function(e){ if (e!==undefined) { "x".repeat(2**28);} __done=true;};
Promise.reject(1); Promise.resolve().then(function(){ $DONE(new Error("f")); });
