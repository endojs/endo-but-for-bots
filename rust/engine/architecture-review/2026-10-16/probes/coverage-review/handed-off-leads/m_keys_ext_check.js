var o = Object.preventExtensions({a: 1, b: 2}); if (Object.isExtensible(o)) throw new Error("ext");
