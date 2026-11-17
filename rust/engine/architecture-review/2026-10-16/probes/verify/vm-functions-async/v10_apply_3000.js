function f(){return arguments.length} var a=[]; for (var i=0;i<3000;i++) a.push(i); var r; try { r = f.apply(null,a); } catch (e) { r = "caught " + e; } throw new Error("argc=3000 => " + r);
