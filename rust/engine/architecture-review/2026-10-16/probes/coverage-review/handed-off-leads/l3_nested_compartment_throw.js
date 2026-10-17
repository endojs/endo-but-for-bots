var c = new Compartment({});
var r; try { c.evaluate("var a = ['xxxxxxxxxx']; for (var i = 0; i < 24; i++) a = [a, a]; throw a;"); } catch (e) { r = 'caught'; }
void 0;
