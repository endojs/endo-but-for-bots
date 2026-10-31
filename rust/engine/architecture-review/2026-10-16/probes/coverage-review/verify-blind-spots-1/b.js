var R; try { var C = eval('(class { constructor(x){ this.x = x; } })'); var B = C.bind(null, 7); R = new B().x; } catch (e) { R = 'caught ' + e; } throw new Error(String(R));
