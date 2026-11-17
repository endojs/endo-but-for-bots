class R extends RegExp { get global() { return "sub"; } } throw new Error(String(new R("a").global));
