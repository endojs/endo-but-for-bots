function z(x){ return Object.is(x, -0) ? '-0' : String(x); }
var r = [
  parseInt('-0'), parseInt('-00'), parseInt('-0x0'), parseInt('-0', 16), parseInt(' -0.5'),
  parseInt(-0.5), Number.parseInt('-0'), parseInt('-0', 2), parseInt('-0abc'),
  1/parseInt('-0'), parseInt('0'), parseInt('-5'), parseInt('-0.9e3'),
  Number.parseInt === parseInt
].map(z);
throw new Error(JSON.stringify(r));
