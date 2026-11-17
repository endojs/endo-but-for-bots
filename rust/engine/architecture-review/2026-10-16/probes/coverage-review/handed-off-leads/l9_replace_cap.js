// A RegExp whose exec returns a result claiming 2^24 + 2 elements (captures_count = 2^24 + 1).
var re = /x/; var calls = 0;
re.exec = function () { if (calls++) return null; return { length: 16777218, 0: 'x', index: 0 }; };
var r = 'x'.replace(re, 'y');
if (r !== 'y') throw new Error('got ' + r);
