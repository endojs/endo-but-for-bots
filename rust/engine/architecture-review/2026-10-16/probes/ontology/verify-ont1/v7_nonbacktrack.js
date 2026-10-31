// does a non-anchored /a/ test over a long subject also trip? (no retained states expected)
const s = "b".repeat(200000) + "a";
throw new Error("plain:" + /a/.test(s) + " lazy:" + /^a+?$/.test("a".repeat(70000)));
