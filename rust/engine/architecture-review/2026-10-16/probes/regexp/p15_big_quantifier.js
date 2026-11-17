let r;
try { r = new RegExp("a{2147483648}").test("a"); } catch (e) { r = "caught " + e.name; }
throw new Error(JSON.stringify(r));
