var o = {b:1, a:2, 1:3, 0:4};
throw new Error(JSON.stringify(Object.keys(o)));
