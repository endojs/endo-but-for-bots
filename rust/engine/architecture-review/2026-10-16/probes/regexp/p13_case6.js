class R extends RegExp { get flags() { return "g"; } } throw new Error("aa".replaceAll(new R("a"), "b"));
