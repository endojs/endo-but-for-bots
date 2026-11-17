var keep=[]; for (var i=0;i<1000;i++) keep.push(new RegExp("a","v")); throw new Error(String(keep.length));
