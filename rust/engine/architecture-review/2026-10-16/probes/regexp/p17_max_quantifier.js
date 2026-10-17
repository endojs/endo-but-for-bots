let r;
try { r = [new RegExp("a{2147483647}").test("a"), new RegExp("a{1,2147483647}").test("a")]; } catch (e) { r = "caught " + e.name; }
throw new Error(JSON.stringify(r));
