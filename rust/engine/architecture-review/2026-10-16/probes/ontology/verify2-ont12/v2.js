function z(x){ return Object.is(x, -0) ? '-0' : String(x); }
var r = [
  parseInt('-0'), parseInt(-0.5), parseInt('-0.9'), Number.parseInt('-0'),
  parseInt(-0), parseInt('0'),
  // downstream effects a program might see
  1/parseInt('-0'), Math.atan2(parseInt('-0'), -1), Object.is(parseInt('-0'), -0),
  // other -0 producers through the same Slot paths
  Number('-0'), +'-0', parseFloat('-0'), Math.trunc(-0.5), -0 * 1, JSON.parse('-0'),
  Math.round(-0.4), (-0.5)|0
].map(z);
throw new Error(JSON.stringify(r));
