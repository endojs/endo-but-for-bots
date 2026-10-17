var keep = []; for (var i = 0; i < 100000; i++) keep.push(new Promise(function () {})); throw new Error('done ' + keep.length);
