var out = [];
function c(name, f) { var r; try { r = JSON.stringify(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("super-index-set-array", function () { class A extends Array { m() { super[0] = 5; return [this.length, this[0], Object.keys(this)]; } } return new A().m(); });
c("super-index-set-obj", function () { var o = { __proto__: {}, m() { super[3] = "x"; return [this[3], Object.keys(this)]; } }; return o.m(); });
c("super-index-get", function () { class A extends Array { m() { return super[0]; } } var a = new A(); a.push(9); return a.m(); });
c("super-index-set-ta-proto", function () { var o = { __proto__: new Uint8Array(2), m() { super[1] = 7; return [Object.keys(this).length, this.hasOwnProperty(1)]; } }; return o.m(); });
throw new Error(JSON.stringify(out));
