var C = (0, eval)('(class { constructor(x) { this.x = x; } })');
var BCl = C.bind(null, 7);
var r = new BCl().x;
throw new Error(String(r));
