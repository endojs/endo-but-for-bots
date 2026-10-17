function f(){let x=1; return x} var s=0; for (var i=0;i<10000;i++) { s+=f(); }
