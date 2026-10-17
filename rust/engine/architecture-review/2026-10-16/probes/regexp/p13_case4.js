class R extends RegExp { get flags() { return "zz"; } } throw new Error(String(new R("a", "g").flags));
