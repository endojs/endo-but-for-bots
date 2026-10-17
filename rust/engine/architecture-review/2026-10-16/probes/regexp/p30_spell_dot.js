const m = /a/.exec("xa"); const got = m.index; throw new Error(JSON.stringify([m["index"], Object.keys(m)]));
