// Same pattern via eval: is the compile-time refusal catchable by the guest?
let out;
try { out = eval("/b{2147483648}/").test(""); } catch (e) { out = "caught " + e.name + ": " + e.message; }
throw new Error("result: " + out);
