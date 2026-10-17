const k = "ind" + "ex"; const m = /a/.exec("xa"); throw new Error(JSON.stringify([m[k], Object.keys(m)]));
