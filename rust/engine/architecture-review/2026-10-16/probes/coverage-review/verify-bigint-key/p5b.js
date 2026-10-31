var o = {[1n]: 5}; if (Object.keys(o)[0] !== "1") throw new Error("bad"); throw new Error("ok-reached:" + Object.keys(o));
