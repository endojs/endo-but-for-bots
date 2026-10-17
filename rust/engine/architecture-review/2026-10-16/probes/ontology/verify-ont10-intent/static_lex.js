var p; class C { static { let x = 1; } static { p = 2; } }
if (p !== 2) throw new Error("p=" + p);
