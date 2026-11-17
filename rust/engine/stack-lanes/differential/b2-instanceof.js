// B2: `instanceof` through bound functions. The uncharged walk of null-prototype
// bound functions, deep.
function F() {}
Object.setPrototypeOf(F, null);
var b = F;
for (var i = 0; i < 3000; i++) {
  b = Function.prototype.bind.call(b, null);
  Object.setPrototypeOf(b, null);
}
[new F() instanceof b, {} instanceof b, 1 instanceof b].join()
// ---
// The charged walk: each layer inherits the intrinsic @@hasInstance, up to the budget.
function F() {}
var r = [], ns = [1, 50, 125];
for (var j = 0; j < ns.length; j++) {
  var b = F;
  for (var i = 0; i < ns[j]; i++) b = b.bind(null);
  r.push(new F() instanceof b, {} instanceof b);
}
r.join()
// ---
// One layer past the budget halts.
function F() {}
var b = F;
for (var i = 0; i < 126; i++) b = b.bind(null);
new F() instanceof b
// ---
// An own @@hasInstance on one layer of an otherwise uncharged chain: it is called with
// that layer as `this`, and the layers below it are never visited.
function F() {}
Object.setPrototypeOf(F, null);
var seen = [];
var b = F;
for (var i = 0; i < 10; i++) {
  b = Function.prototype.bind.call(b, null);
  Object.setPrototypeOf(b, null);
  if (i === 6) {
    (function (layer) {
      Object.defineProperty(layer, Symbol.hasInstance, {
        value: function (v) { seen.push(this === layer, typeof v); return 'yes'; },
      });
    })(b);
  }
}
[new F() instanceof b, seen.join('/')].join()
// ---
// A getter for @@hasInstance on a layer that counts its reads, returning undefined, so the
// walk continues below it; then one that throws.
function F() {}
Object.setPrototypeOf(F, null);
var reads = 0;
var b = F;
for (var i = 0; i < 20; i++) {
  b = Function.prototype.bind.call(b, null);
  Object.setPrototypeOf(b, null);
  if (i % 5 === 0) Object.defineProperty(b, Symbol.hasInstance, { get: function () { reads++; return undefined; } });
}
var r = [new F() instanceof b, reads];
var c = Function.prototype.bind.call(b, null);
Object.setPrototypeOf(c, null);
Object.defineProperty(b, Symbol.hasInstance, { get: function () { throw new RangeError('at layer'); } });
try { r.push(new F() instanceof c); } catch (e) { r.push(e.name + ':' + e.message); }
r.join()
// ---
// A non-callable @@hasInstance on a layer is a TypeError; so is a non-object right operand.
function F() {}
Object.setPrototypeOf(F, null);
var b = Function.prototype.bind.call(F, null);
Object.setPrototypeOf(b, null);
var c = Function.prototype.bind.call(b, null);
Object.setPrototypeOf(c, null);
Object.defineProperty(b, Symbol.hasInstance, { value: 42 });
var r = [];
try { r.push({} instanceof c); } catch (e) { r.push(e.name); }
try { r.push({} instanceof 3); } catch (e) { r.push(e.name); }
try { r.push({} instanceof {}); } catch (e) { r.push(e.name); }
r.join()
// ---
// A Proxy at the top of a bound chain (bind refuses a Proxy below it): its get trap answers
// @@hasInstance, then OrdinaryHasInstance reads its `prototype` without unwrapping the bound
// function under it; a revoked one throws.
function F() {}
Object.setPrototypeOf(F, null);
var b = Function.prototype.bind.call(F, null);
Object.setPrototypeOf(b, null);
var log = [];
var p = new Proxy(b, { get: function (t, k, r) { log.push(typeof k === 'symbol' ? k.description : k); return Reflect.get(t, k, r); } });
var out = [];
try { out.push(new F() instanceof p); } catch (e) { out.push(e.name + ':' + e.message); }
out.push(log.join('/'));
var pr = Proxy.revocable(b, {});
pr.revoke();
try { out.push({} instanceof pr.proxy); } catch (e) { out.push(e.name); }
out.join()
// ---
// A Proxy as the prototype of every lower layer: its get trap sees each lookup with the layer
// as receiver, returning undefined until layer 3 answers with a function.
function F() {}
Object.setPrototypeOf(F, null);
var layers = [F], log = [], answerAt = 3;
var proxy = new Proxy({}, { get: function (t, k, r) {
  var idx = layers.indexOf(r); log.push(String(k === Symbol.hasInstance) + idx);
  if (idx === answerAt) return function (v) { log.push('call' + (this === r)); return 0; };
  return undefined; } });
var b = F;
for (var i = 0; i < 8; i++) { b = Function.prototype.bind.call(b, null); Object.setPrototypeOf(b, proxy); layers.push(b); }
var r1 = new F() instanceof b; answerAt = -1; var r2 = new F() instanceof b;
[r1, r2, log.join('/')].join()
// ---
// A null @@hasInstance on a layer (GetMethod treats it as absent), and layers whose prototype
// is an ordinary object without one.
function F() {}
Object.setPrototypeOf(F, null);
var plain = {};
var b = F;
for (var i = 0; i < 40; i++) {
  b = Function.prototype.bind.call(b, null);
  Object.setPrototypeOf(b, i % 2 ? null : plain);
  if (i % 7 === 0) Object.defineProperty(b, Symbol.hasInstance, { value: null });
}
[new F() instanceof b, {} instanceof b, Object.create(F.prototype) instanceof b].join()
// ---
// An inherited @@hasInstance getter: its receiver per layer, a re-entrant instanceof on the
// same chain, and a lower layer's prototype rewired mid-walk.
function F() {}
Object.setPrototypeOf(F, null);
var layers = [F], log = [], depth = 0, proto = {};
Object.defineProperty(proto, Symbol.hasInstance, { get: function () {
  var idx = layers.indexOf(this); log.push(idx);
  if (idx === 5 && depth === 0) {
    depth++; log.push('re:' + (new F() instanceof layers[4])); depth--;
    Object.setPrototypeOf(layers[2], { [Symbol.hasInstance]: function (v) { log.push('late' + (this === layers[2])); return 'x'; } });
  }
  return undefined; } });
var b = F;
for (var i = 0; i < 8; i++) { b = Function.prototype.bind.call(b, null); Object.setPrototypeOf(b, proto); layers.push(b); }
[new F() instanceof b, new F() instanceof b, log.join('/')].join()
// ---
// A mixed chain: uncharged layers, one with the intrinsic @@hasInstance (back through
// OrdinaryHasInstance's own bound step into the loop), more uncharged layers; and
// Function.prototype[@@hasInstance] called directly.
function F() {}
var b = F;
for (var i = 0; i < 300; i++) { b = Function.prototype.bind.call(b, null); Object.setPrototypeOf(b, null); }
var c = Function.prototype.bind.call(b, null);
for (var i = 0; i < 300; i++) { c = Function.prototype.bind.call(c, null); Object.setPrototypeOf(c, null); }
var hi = Function.prototype[Symbol.hasInstance];
[new F() instanceof c, {} instanceof c, 1 instanceof c, hi.call(c, new F()), hi.call(b, {}), hi.call(3, {}), hi.call({}, {})].join()
// ---
// Bound over a class, and prototypes that are not objects.
class A {}
class B extends A {}
var bb = Function.prototype.bind.call(Function.prototype.bind.call(B, null), null);
Object.setPrototypeOf(bb, null);
function G() {}
G.prototype = 3;
var bg = Function.prototype.bind.call(G, null);
Object.setPrototypeOf(bg, null);
var r = [new B() instanceof bb, new A() instanceof bb];
try { r.push({} instanceof bg); } catch (e) { r.push(e.name); }
r.push(1 instanceof bg);
r.join()
