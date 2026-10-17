const m = /(?<y>a)/.exec("xa");
throw new Error(JSON.stringify([Object.keys({ ...m }), Object.keys(Object.assign({}, m)), Object.getOwnPropertyNames(m)]));
