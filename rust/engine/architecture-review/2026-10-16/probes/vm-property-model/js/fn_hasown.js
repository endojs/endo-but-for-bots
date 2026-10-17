(function(){ var o = {alpha: 1}; var k = 'alpha'; var s = 0; var h = Object.prototype.hasOwnProperty; for (var i = 0; i < 100000; i++) { if (h.call(o, k)) s++; } })();
