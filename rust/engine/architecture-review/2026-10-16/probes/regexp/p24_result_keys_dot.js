const m = /a/.exec("xa"); const k1 = Object.keys(m); const i = m.index; throw new Error(JSON.stringify([k1, i, m["input"], "groups" in m, Object.getOwnPropertyNames(m)]));
