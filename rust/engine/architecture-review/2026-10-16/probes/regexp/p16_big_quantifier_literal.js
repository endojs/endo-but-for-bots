let r;
try { r = /a{0,4294967296}/.test("a"); } catch (e) { r = "caught " + e.name; }
throw new Error(JSON.stringify(r));
