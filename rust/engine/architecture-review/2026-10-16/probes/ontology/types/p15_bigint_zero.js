var out = {};
function t(name, f){ try { out[name] = f(); } catch (e) { out[name] = 'THROW ' + (e && e.name) + ':' + String(e && e.message); } }
var zs = {
  neg: function(){ return -0n; },
  mul: function(){ return 0n * -1n; },
  add: function(){ return -1n + 1n; },
  mod: function(){ return (-5n) % 5n; },
  div: function(){ return (-3n) / 4n; },
  sub: function(){ return 5n - 5n; },
  and: function(){ return (-1n) & 0n; },
  asIntN: function(){ return BigInt.asIntN(64, -(2n ** 64n)); },
  asUintN: function(){ return BigInt.asUintN(0, -1n); },
  asIntN0: function(){ return BigInt.asIntN(0, -5n); },
  fromStr: function(){ return BigInt("-0"); },
  fromNum: function(){ return BigInt(-0); },
  shr: function(){ return (-1n) >> 100n ; },
  shl: function(){ return (0n) << 5n; },
  neg_shr: function(){ return (-4n) >> 3n; },
  pow: function(){ return (-0n) ** 3n; },
  exp0: function(){ return 0n ** 1n; },
  dec: function(){ var x = -1n; x++; return x; },
  bi64: function(){ var a = new BigInt64Array(1); a[0] = -(2n**64n); return a[0]; },
  parse: function(){ return BigInt("-0x0"); },
  xor: function(){ return (-7n) ^ (-7n); },
  or_neg: function(){ return (-8n) | 0n; },
  shr_neg_small: function(){ return (-1n) >> 1n; },
  mod_neg_big: function(){ return (-(2n**70n)) % (2n**35n); },
  div_neg_big: function(){ return (-(2n**33n)) / (2n**70n); },
  sub_big: function(){ return (2n**70n) - (2n**70n); },
  neg_big_add: function(){ return (-(2n**70n)) + (2n**70n); },
  mul_neg_big: function(){ return (-(2n**70n)) * 0n; },
};
Object.keys(zs).forEach(function(k){ t(k, function(){ var z = zs[k](); return [String(z), z === 0n, Object.is(z, 0n), new Set([0n, z]).size, z < 0n, -z === 0n, new Map([[0n, 'a']]).get(z), z.toString(16), String(z * -1n), String(z - 1n), JSON.stringify([z == 0, z == '0', z == false])].join(' '); }); });
throw new Error(JSON.stringify(out));
