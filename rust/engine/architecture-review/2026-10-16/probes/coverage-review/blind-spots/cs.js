var R; try { R = (function () { var c = new Compartment(); var F = c.evaluate('(function (a) { this.a = a; })'); var B = F.bind(null, 4); return new B().a; })(); } catch (e) { R = "caught " + e; }
throw new Error(String(R));
