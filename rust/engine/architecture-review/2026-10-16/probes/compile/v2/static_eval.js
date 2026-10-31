var r;
try { r = eval("class C { static { let x = 1; C.y = x; } } C.y"); } catch (e) { r = "caught " + e.name; }
throw new Error("result=" + r);
