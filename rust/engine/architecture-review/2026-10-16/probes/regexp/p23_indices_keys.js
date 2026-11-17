const d = /a(b)?/d.exec("a"); throw new Error(JSON.stringify([Object.keys(d), Object.keys(d.indices)]));
