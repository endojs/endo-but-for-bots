const m = /a/.exec("xa"); throw new Error(JSON.stringify([m["index"], m["input"], "groups" in m, m.hasOwnProperty("index")]));
